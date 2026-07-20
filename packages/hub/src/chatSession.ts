// chat 会话（#17）：裸 stream-json 长驻子进程驱动（spike #16 选型）。
// 与 owner 的 TUI 用同一个 claude 二进制（版本一致性 = 双模互通 #19 的根基），
// child_process 无 PTY；stdout 逐行 JSON 规整成 ChatItem 时间线，
// 时间线数组即 chat 版回放缓冲（ADR-0005 ring buffer 的对应物）。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type { ChatItem, ChatState } from "@zagent/protocol";

import { cleanEnv, resolveExecutable } from "./session.js";

// 驱动 flags（spike #16 第 4 节实证形态）。策略参数（--resume /
// --dangerously-skip-permissions 等）不在此列，由模板默认 args 与用户附加参数决定。
const DRIVER_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  // stream-json 输出的前置要求；verbose 日志走 stderr，不污染 stdout 的 JSONL
  "--verbose",
  // token 级增量（M2 流式气泡的数据源，spike 实测 64 增量/回合）
  "--include-partial-messages",
];

// 时间线上限：500 条 × 单条 4KB 截断 ≈ 2MB，与 pty ring buffer 同量级（ADR-0005）
const MAX_ITEMS = 500;
const ITEM_TEXT_MAX = 4096;
// 回合中增量预览的累积上限：只影响重连回放的 pending，超限保留头部即可
const PENDING_MAX = 16 * 1024;

function truncate(text: string): string {
  return text.length > ITEM_TEXT_MAX ? `${text.slice(0, ITEM_TEXT_MAX)}…（已截断）` : text;
}

// ---------------------------------------------------------------------------
// stream-json 事件解释器：CLI 原始事件 → 时间线效果。独立于进程壳的纯状态机，可单测。
// ---------------------------------------------------------------------------

export type ChatEffect =
  | { effect: "item"; item: ChatItem }
  | { effect: "delta"; text: string }
  | { effect: "turn-end"; errorText: string | null }
  | { effect: "claude-session-id"; claudeSessionId: string };

export class StreamJsonInterpreter {
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private nextId(): string {
    return `m${++this.counter}`;
  }

  /** 用户输入的时间线回显（stdin 发的是全文，时间线只留截断版）。 */
  userItem(text: string): ChatItem {
    return { kind: "user", id: this.nextId(), text: truncate(text), ts: this.now() };
  }

  systemItem(text: string): ChatItem {
    return { kind: "system", id: this.nextId(), text: truncate(text), ts: this.now() };
  }

  /** 解析一行 stream-json 输出；非 JSON 或不关心的事件返回空。 */
  interpret(line: string): ChatEffect[] {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (typeof event !== "object" || event === null) {
      return [];
    }
    const e = event as Record<string, unknown>;
    switch (e["type"]) {
      case "system":
        if (e["subtype"] === "init" && typeof e["session_id"] === "string") {
          return [{ effect: "claude-session-id", claudeSessionId: e["session_id"] }];
        }
        return [];
      case "stream_event":
        return this.interpretStreamEvent(e);
      case "assistant":
        return this.interpretAssistant(e);
      case "user":
        return this.interpretUser(e);
      case "result": {
        const isError =
          e["is_error"] === true || (typeof e["subtype"] === "string" && e["subtype"] !== "success");
        if (!isError) {
          return [{ effect: "turn-end", errorText: null }];
        }
        const result = e["result"];
        const errorText =
          typeof result === "string" && result !== ""
            ? result
            : `回合异常结束（${String(e["subtype"] ?? "unknown")}）`;
        return [{ effect: "turn-end", errorText }];
      }
      default:
        return [];
    }
  }

  private interpretStreamEvent(e: Record<string, unknown>): ChatEffect[] {
    // 子 agent（Task 工具）的增量不进主预览，定稿条目仍会随 assistant/user 事件进时间线
    if (e["parent_tool_use_id"] != null) {
      return [];
    }
    const inner = e["event"];
    if (typeof inner !== "object" || inner === null) {
      return [];
    }
    const sse = inner as Record<string, unknown>;
    if (sse["type"] !== "content_block_delta") {
      return [];
    }
    const delta = sse["delta"];
    if (typeof delta !== "object" || delta === null) {
      return [];
    }
    const d = delta as Record<string, unknown>;
    // 只转发正文增量；thinking / tool 参数的增量不做打字机（定稿即可）
    if (d["type"] === "text_delta" && typeof d["text"] === "string" && d["text"] !== "") {
      return [{ effect: "delta", text: d["text"] }];
    }
    return [];
  }

  private interpretAssistant(e: Record<string, unknown>): ChatEffect[] {
    const content = contentBlocks(e);
    const effects: ChatEffect[] = [];
    for (const block of content) {
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
        effects.push({
          effect: "item",
          item: { kind: "assistant", id: this.nextId(), text: truncate(block["text"]), ts: this.now() },
        });
      } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        // id 沿用 CLI 的 tool_use id（toolu_…），tool_result 凭 toolUseId 与之配对
        const id = typeof block["id"] === "string" ? block["id"] : this.nextId();
        effects.push({
          effect: "item",
          item: {
            kind: "tool_use",
            id,
            name: block["name"],
            input: truncate(safeStringify(block["input"])),
            ts: this.now(),
          },
        });
      }
      // thinking block 跳过：M1 不进时间线
    }
    return effects;
  }

  private interpretUser(e: Record<string, unknown>): ChatEffect[] {
    // user 事件里只认 tool_result；text block 是自己输入的回显，
    // Hub 在发送时已定稿 user 条目，这里跳过防重复
    const content = contentBlocks(e);
    const effects: ChatEffect[] = [];
    for (const block of content) {
      if (block["type"] !== "tool_result") {
        continue;
      }
      effects.push({
        effect: "item",
        item: {
          kind: "tool_result",
          id: this.nextId(),
          toolUseId: typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "",
          text: truncate(extractResultText(block["content"])),
          isError: block["is_error"] === true,
          ts: this.now(),
        },
      });
    }
    return effects;
  }
}

function contentBlocks(e: Record<string, unknown>): Record<string, unknown>[] {
  const message = e["message"];
  if (typeof message !== "object" || message === null) {
    return [];
  }
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
  );
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>)["type"] === "text" &&
      typeof (block as Record<string, unknown>)["text"] === "string"
    ) {
      parts.push((block as Record<string, unknown>)["text"] as string);
    }
  }
  return parts.join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 进程壳
// ---------------------------------------------------------------------------

export interface ChatSessionOptions {
  id: string;
  command: string;
  /** 策略参数（模板默认或用户覆盖：--resume、--dangerously-skip-permissions 等）。 */
  args?: string[];
  cwd: string;
}

type Listener<T> = (value: T) => void;

export class ChatSession {
  readonly id: string;
  readonly type = "chat" as const;
  /** 实际驱动命令行（含驱动 flags），供列表诚实展示。 */
  readonly commandLine: string;
  exited = false;
  claudeSessionId: string | null = null;

  private readonly child: ChildProcess;
  private readonly interpreter = new StreamJsonInterpreter();
  private readonly items: ChatItem[] = [];
  private pendingText = "";
  private state: ChatState = "idle";
  private stderrTail = "";

  private readonly itemListeners: Listener<ChatItem>[] = [];
  private readonly deltaListeners: Listener<string>[] = [];
  private readonly stateListeners: Listener<ChatState>[] = [];
  private readonly sessionIdListeners: Listener<string>[] = [];
  private readonly exitListeners: Listener<number>[] = [];

  constructor(options: ChatSessionOptions) {
    this.id = options.id;
    const args = [...DRIVER_ARGS, ...(options.args ?? [])];
    this.commandLine = [options.command, ...args].join(" ");
    this.child = spawnStreamJson(resolveExecutable(options.command), args, options.cwd);

    // stdin EPIPE（进程先死）交给 exit 路径收口，不让未捕获错误带崩 Hub
    this.child.stdin?.on("error", () => {});
    if (this.child.stdout !== null) {
      const rl = createInterface({ input: this.child.stdout });
      rl.on("line", (line) => {
        try {
          this.handleLine(line);
        } catch (err) {
          console.error(`[hub] chat 会话 ${this.id} 事件处理失败:`, err);
        }
      });
    }
    // --verbose 日志走 stderr；留尾巴用于异常退出时给用户看得见的原因
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2048);
    });
    this.child.on("exit", (code) => this.handleExit(code ?? -1));
    this.child.on("error", (err) => {
      // spawn 失败（可执行不存在等）不会再有 exit 事件，这里统一收口
      this.stderrTail = `${this.stderrTail}\n${err.message}`.slice(-2048);
      this.handleExit(-1);
    });
  }

  /** 用户输入：stdin 发全文（一行一条 stream-json user 消息），时间线定稿回显。 */
  sendUserText(text: string): void {
    if (this.exited || this.child.stdin === null) {
      return;
    }
    const message = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.pushItem(this.interpreter.userItem(text));
    this.setState("thinking");
  }

  /** attach 重放（ADR-0005）：完整时间线 + 状态 + 回合中未定稿的增量累积。 */
  history(): { items: ChatItem[]; state: ChatState; pending?: string } {
    const items = [...this.items];
    return this.pendingText === ""
      ? { items, state: this.state }
      : { items, state: this.state, pending: this.pendingText };
  }

  onItem(listener: Listener<ChatItem>): void {
    this.itemListeners.push(listener);
  }

  onDelta(listener: Listener<string>): void {
    this.deltaListeners.push(listener);
  }

  onState(listener: Listener<ChatState>): void {
    this.stateListeners.push(listener);
  }

  onSessionId(listener: Listener<string>): void {
    this.sessionIdListeners.push(listener);
  }

  onExit(listener: Listener<number>): void {
    this.exitListeners.push(listener);
  }

  kill(): void {
    if (this.exited) {
      return;
    }
    const pid = this.child.pid;
    if (process.platform === "win32" && pid !== undefined) {
      // .cmd 外壳下真身是孙进程：taskkill /T 杀整棵树，对齐 conpty 的 pty.kill 语义
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
        "error",
        () => this.child.kill(),
      );
    } else {
      this.child.kill("SIGTERM");
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    for (const eff of this.interpreter.interpret(trimmed)) {
      switch (eff.effect) {
        case "claude-session-id": {
          this.claudeSessionId = eff.claudeSessionId;
          for (const l of this.sessionIdListeners) {
            l(eff.claudeSessionId);
          }
          break;
        }
        case "delta": {
          if (this.pendingText.length < PENDING_MAX) {
            this.pendingText += eff.text;
          }
          for (const l of this.deltaListeners) {
            l(eff.text);
          }
          break;
        }
        case "item": {
          // assistant 定稿包含全文，覆盖打字机预览
          if (eff.item.kind === "assistant") {
            this.pendingText = "";
          }
          this.pushItem(eff.item);
          break;
        }
        case "turn-end": {
          this.pendingText = "";
          if (eff.errorText !== null) {
            this.pushItem(this.interpreter.systemItem(eff.errorText));
          }
          this.setState("idle");
          break;
        }
      }
    }
  }

  private pushItem(item: ChatItem): void {
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) {
      this.items.splice(0, this.items.length - MAX_ITEMS);
    }
    for (const l of this.itemListeners) {
      l(item);
    }
  }

  private setState(state: ChatState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const l of this.stateListeners) {
      l(state);
    }
  }

  private handleExit(exitCode: number): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    if (exitCode !== 0) {
      const tail = this.stderrTail.trim();
      this.pushItem(
        this.interpreter.systemItem(
          tail === "" ? `claude 进程异常退出（code ${exitCode}）` : `claude 进程异常退出（code ${exitCode}）：${tail}`,
        ),
      );
    }
    for (const l of this.exitListeners) {
      l(exitCode);
    }
  }
}

function spawnStreamJson(executable: string, args: string[], cwd: string): ChildProcess {
  // Windows：npm 全局安装的 claude 是 .cmd 包装，Node（CVE-2024-27980 之后）拒绝直接
  // spawn .cmd/.bat，必须过 shell；而 shell:true 只做裸拼接，引号得自己上
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const line = [executable, ...args].map(quoteForCmd).join(" ");
    return spawn(line, { shell: true, cwd, env: cleanEnv(), stdio: "pipe", windowsHide: true });
  }
  return spawn(executable, args, { cwd, env: cleanEnv(), stdio: "pipe", windowsHide: true });
}

function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^]/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll('"', '""')}"`;
}
