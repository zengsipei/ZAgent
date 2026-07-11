// 测试共用：WS 测试客户端与连接工具（server.test / lifecycle.test 共享）。

import { WebSocket } from "ws";

import {
  CONTROL_CHANNEL,
  base64ToUtf8,
  parseEnvelope,
  serializeEnvelope,
  sessionChannel,
  utf8ToBase64,
  type Envelope,
  type SessionInfo,
} from "@zagent/protocol";

export const TOKEN = "t".repeat(64);
export const ORIGIN = "http://localhost:5173";

/**
 * 周期性重试 action 直到 predicate 命中；超时抛错。
 * Windows ConPTY + MSYS bash 下，恰逢 resize 重绘窗口的单次输入可能被丢，
 * 幂等动作重发以消除时序抖动。
 */
export async function retryUntil(
  action: () => void,
  predicate: () => boolean,
  options: { intervalMs?: number; timeoutMs?: number; message: string },
): Promise<void> {
  const { intervalMs = 1000, timeoutMs = 15000, message } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    action();
    const slice = Math.min(Date.now() + intervalMs, deadline);
    while (Date.now() < slice) {
      if (predicate()) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(message);
}

/** 打开连接并等待结果；被拒时 resolve 为 null。 */
export function tryConnect(url: string, origin?: string): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    ws.once("open", () => resolve(ws));
    ws.once("error", () => resolve(null));
  });
}

/**
 * 测试客户端：从构造起就缓冲全部信封（hello 与首屏输出可能在 open
 * 的同一个 tick 到达，事后挂监听会漏掉），并断言每条消息都是合法信封。
 */
export class TestClient {
  readonly envelopes: Envelope[] = [];
  /** 按会话通道分桶的输出文本。 */
  readonly outputs = new Map<string, string>();
  private readonly ws: WebSocket;
  private readonly opened: Promise<boolean>;
  private badMessage: string | null = null;

  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin === undefined ? {} : { origin });
    this.ws.on("message", (raw) => {
      const env = parseEnvelope(String(raw));
      if (env === null) {
        this.badMessage = String(raw).slice(0, 120);
        return;
      }
      this.envelopes.push(env);
      if (env.type === "output") {
        const prev = this.outputs.get(env.channel) ?? "";
        this.outputs.set(env.channel, prev + base64ToUtf8((env.payload as { data: string }).data));
      }
    });
    this.opened = new Promise((resolve) => {
      this.ws.once("open", () => resolve(true));
      this.ws.once("error", () => resolve(false));
    });
  }

  async connect(): Promise<boolean> {
    return this.opened;
  }

  send(channel: string, type: string, payload: unknown): void {
    this.ws.send(serializeEnvelope({ channel, type, payload }));
  }

  sendInput(sessionId: string, text: string): void {
    this.send(sessionChannel(sessionId), "input", { data: utf8ToBase64(text) });
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  outputOf(sessionId: string): string {
    return this.outputs.get(sessionChannel(sessionId)) ?? "";
  }

  /** 轮询等待条件命中；顺带断言途中没有收到非信封消息。 */
  async waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.badMessage !== null) {
        throw new Error(`收到非信封消息: ${this.badMessage}`);
      }
      if (predicate()) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `等待超时，已收到信封: ${JSON.stringify(this.envelopes.map((e) => `${e.channel}/${e.type}`))}`,
    );
  }

  waitForOutput(sessionId: string, text: string, timeoutMs?: number): Promise<void> {
    return this.waitFor(() => this.outputOf(sessionId).includes(text), timeoutMs);
  }

  /** 幂等探针：周期性重发输入直到输出命中（见 retryUntil 的时序抖动说明）。 */
  async probeOutput(sessionId: string, input: string, text: string, timeoutMs = 15000): Promise<void> {
    await retryUntil(
      () => this.sendInput(sessionId, input),
      () => this.outputOf(sessionId).includes(text),
      { timeoutMs, message: `探针超时：${input.trim()} 未产出 ${text}` },
    );
  }

  /** 等待并返回第一条匹配类型的 control 信封 payload。 */
  async waitForControl<T>(type: string, predicate?: (payload: T) => boolean): Promise<T> {
    let found: T | undefined;
    await this.waitFor(() => {
      const env = this.envelopes.find(
        (e) =>
          e.channel === CONTROL_CHANNEL &&
          e.type === type &&
          (predicate === undefined || predicate(e.payload as T)),
      );
      if (env !== undefined) {
        found = env.payload as T;
        return true;
      }
      return false;
    });
    return found!;
  }

  /** 创建 bash 会话并 attach，等到提示符出现，返回 sessionId。 */
  async createAndAttachShell(cwd = process.cwd()): Promise<string> {
    const before = this.envelopes.filter((e) => e.type === "created").length;
    this.send(CONTROL_CHANNEL, "create", { template: "bash", cwd });
    await this.waitFor(() => this.envelopes.filter((e) => e.type === "created").length > before);
    const created = this.envelopes.filter((e) => e.type === "created")[before]!;
    const id = (created.payload as { session: SessionInfo }).session.id;
    this.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    await this.waitForOutput(id, "$");
    return id;
  }

  latestSessions(): SessionInfo[] {
    for (let i = this.envelopes.length - 1; i >= 0; i--) {
      const env = this.envelopes[i]!;
      if (env.channel === CONTROL_CHANNEL && (env.type === "sessions" || env.type === "hello")) {
        return (env.payload as { sessions: SessionInfo[] }).sessions;
      }
    }
    return [];
  }

  close(): void {
    this.ws.close();
  }

  /** 模拟异常断网：不发 close 帧直接掐断 TCP。 */
  destroy(): void {
    this.ws.terminate();
  }
}
