// PTY 会话：node-pty spawn 的被控进程包装（一期 type 仅 pty）。

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import pty from "node-pty";

import type { SessionType } from "@zagent/protocol";

export interface PtySessionOptions {
  id: string;
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
}

// attach 重放缓冲上限（ADR-0005：数 MB 级 ring buffer，按 UTF-16 字符近似计）
const RING_BUFFER_MAX_CHARS = 1024 * 1024;

// 抖动尺寸保持多久后恢复：太短两次 SIGWINCH 可能被 TUI 合并成无重绘
export const NUDGE_RESTORE_DELAY_MS = 50;

// attach 到抖动的延迟：等客户端 attach 后的首个 resize 先落地。抖动若与它抢跑，
// resize 会把抖动窗口截短成一个 RTT，快到 TUI 感知不到中间尺寸
export const NUDGE_AFTER_ATTACH_DELAY_MS = 250;

export class PtySession {
  readonly id: string;
  readonly type: SessionType = "pty";
  exited = false;

  private readonly pty: pty.IPty;
  private readonly ringChunks: string[] = [];
  private ringLength = 0;
  private pendingNudgeRestore: NodeJS.Timeout | null = null;
  private scheduledNudge: NodeJS.Timeout | null = null;
  // 自行跟踪尺寸：Windows conpty 下 pty.cols/rows getter 在 resize 后不更新
  private cols: number;
  private rows: number;

  constructor(options: PtySessionOptions) {
    this.id = options.id;
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.pty = pty.spawn(resolveExecutable(options.command), options.args ?? [], {
      name: "xterm-256color",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: cleanEnv(),
    });
    this.pty.onExit(() => {
      this.exited = true;
    });
    this.pty.onData((data) => {
      this.ringChunks.push(data);
      this.ringLength += data.length;
      while (this.ringLength > RING_BUFFER_MAX_CHARS && this.ringChunks.length > 1) {
        this.ringLength -= this.ringChunks.shift()!.length;
      }
    });
  }

  /** attach 时重放的最近输出（ring buffer 内容拼接）。 */
  replayData(): string {
    return this.ringChunks.join("");
  }

  /** 会话当前有效尺寸（自跟踪值；重绘抖动的瞬态尺寸不反映在此）。 */
  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  onData(listener: (data: string) => void): void {
    this.pty.onData(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.pty.onExit(({ exitCode }) => listener(exitCode));
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    // 尺寸未变就不动 PTY：不产生 SIGWINCH，也不打断进行中/已排期的抖动
    // （重连客户端窗口没变时，收敛全靠抖动）
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    // 真实尺寸变化本身就逼整屏重绘，抖动残留一并作废（最后 resize 者胜）
    this.cancelNudgeRestore();
    this.cancelScheduledNudge();
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  /**
   * 重绘抖动（ADR-0005）：attach 重放后微调一次 PTY 尺寸再恢复，
   * 用 SIGWINCH 逼全屏 TUI 整屏重绘。延迟触发，等客户端 attach 后的首个 resize 先落地。
   */
  scheduleNudge(): void {
    if (this.exited) {
      return;
    }
    this.cancelScheduledNudge();
    this.scheduledNudge = setTimeout(() => {
      this.scheduledNudge = null;
      this.nudgeResize();
    }, NUDGE_AFTER_ATTACH_DELAY_MS);
  }

  private nudgeResize(): void {
    if (this.exited) {
      return;
    }
    this.cancelNudgeRestore();
    const { cols, rows } = this;
    this.pty.resize(cols, rows + 1);
    this.pendingNudgeRestore = setTimeout(() => {
      this.pendingNudgeRestore = null;
      if (!this.exited) {
        this.pty.resize(cols, rows);
      }
    }, NUDGE_RESTORE_DELAY_MS);
  }

  private cancelNudgeRestore(): void {
    if (this.pendingNudgeRestore !== null) {
      clearTimeout(this.pendingNudgeRestore);
      this.pendingNudgeRestore = null;
    }
  }

  private cancelScheduledNudge(): void {
    if (this.scheduledNudge !== null) {
      clearTimeout(this.scheduledNudge);
      this.scheduledNudge = null;
    }
  }

  kill(): void {
    this.cancelNudgeRestore();
    this.cancelScheduledNudge();
    if (!this.exited) {
      this.pty.kill();
    }
  }
}

// 会话环境 = 宿主环境去掉 Claude Code 的会话标记（CLAUDECODE、CLAUDE_CODE_SESSION_ID 等）：
// Hub 若由某个 Claude Code 会话里的终端启动，这些标记会泄进被控 CLI，
// 让它自认嵌套子会话而行为漂移。CLAUDE_CONFIG_DIR 例外保留（Docker 凭证卷依赖，ADR-0002）。
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if ((key === "CLAUDECODE" || key.startsWith("CLAUDE_")) && key !== "CLAUDE_CONFIG_DIR") {
      continue;
    }
    env[key] = value;
  }
  return env;
}

// Windows 上 node-pty 需要可执行文件的完整路径（裸命令名会报 File not found），
// 因此手动沿 PATH + PATHEXT 解析；类 Unix 平台交给系统解析即可。
function resolveExecutable(command: string): string {
  if (process.platform !== "win32" || isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return command;
  }
  const pathDirs = (process.env["PATH"] ?? "").split(delimiter);
  const extensions = command.includes(".")
    ? [""]
    : (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";");
  for (const dir of pathDirs) {
    if (dir === "") {
      continue;
    }
    for (const ext of extensions) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}
