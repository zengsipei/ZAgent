import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  CONTROL_CHANNEL,
  base64ToUtf8,
  parseEnvelope,
  serializeEnvelope,
  sessionChannel,
  utf8ToBase64,
  type Envelope,
} from "@zagent/protocol";

import { loadConfig } from "../src/config.js";
import { startHub, type RunningHub } from "../src/server.js";

const TOKEN = "t".repeat(64);
const ORIGIN = "http://localhost:5173";

let hub: RunningHub;

beforeAll(async () => {
  hub = await startHub(loadConfig({ ZAGENT_TOKEN: TOKEN, ZAGENT_PORT: "0" }));
});

afterAll(async () => {
  await hub.close();
});

function wsUrl(token?: string): string {
  const query = token === undefined ? "" : `?token=${token}`;
  return `ws://127.0.0.1:${hub.port}/ws${query}`;
}

/** 打开连接并等待结果；被拒时 resolve 为 null。 */
function tryConnect(url: string, origin?: string): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    ws.once("open", () => resolve(ws));
    ws.once("error", () => resolve(null));
  });
}

/**
 * 测试客户端：从构造起就缓冲全部信封（attached 与首屏输出可能在 open
 * 的同一个 tick 到达，事后挂监听会漏掉），并断言每条消息都是合法信封。
 */
class TestClient {
  readonly envelopes: Envelope[] = [];
  outputText = "";
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
        this.outputText += base64ToUtf8((env.payload as { data: string }).data);
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

  sendInput(text: string): void {
    this.ws.send(
      serializeEnvelope({
        channel: sessionChannel("main"),
        type: "input",
        payload: { data: utf8ToBase64(text) },
      }),
    );
  }

  sendResize(cols: number, rows: number): void {
    this.ws.send(
      serializeEnvelope({
        channel: CONTROL_CHANNEL,
        type: "resize",
        payload: { sessionId: "main", cols, rows },
      }),
    );
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
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
    throw new Error(`等待超时，已收到输出: ${JSON.stringify(this.outputText.slice(-300))}`);
  }

  waitForOutput(text: string, timeoutMs?: number): Promise<void> {
    return this.waitFor(() => this.outputText.includes(text), timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

describe("底线认证在 upgrade 阶段生效", () => {
  it("缺失 token → 连接被拒", async () => {
    expect(await tryConnect(wsUrl(), ORIGIN)).toBeNull();
  });

  it("错误 token → 连接被拒", async () => {
    expect(await tryConnect(wsUrl("x".repeat(64)), ORIGIN)).toBeNull();
  });

  it("Origin 不在白名单 → 连接被拒", async () => {
    expect(await tryConnect(wsUrl(TOKEN), "https://evil.example.com")).toBeNull();
  });

  it("缺失 Origin → 连接被拒", async () => {
    expect(await tryConnect(wsUrl(TOKEN))).toBeNull();
  });

  it("路径不是 /ws → 连接被拒（即使 token 正确）", async () => {
    expect(
      await tryConnect(`ws://127.0.0.1:${hub.port}/other?token=${TOKEN}`, ORIGIN),
    ).toBeNull();
  });
});

describe("Hub 监听边界", () => {
  it("仅监听 127.0.0.1", () => {
    expect(hub.address).toBe("127.0.0.1");
  });
});

describe("信封 WS ⇄ PTY 端到端", () => {
  it("连接即 attach，输入回显，resize 生效", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);

    await client.waitFor(() =>
      client.envelopes.some(
        (env) =>
          env.channel === CONTROL_CHANNEL &&
          env.type === "attached" &&
          (env.payload as { sessionId: string }).sessionId === "main" &&
          (env.payload as { sessionType: string }).sessionType === "pty",
      ),
    );

    // 等 bash 就绪（出现提示符 $）再交互
    await client.waitForOutput("$");

    client.sendInput("echo tracer_$((40+2))\r");
    await client.waitForOutput("tracer_42");

    client.sendResize(101, 31);
    client.sendInput("stty size\r");
    await client.waitForOutput("31 101");

    client.close();
  }, 30000);

  it("非法消息不致崩溃，会话继续可用", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);
    await client.waitForOutput("$");

    client.sendRaw("not an envelope");
    client.sendRaw('{"channel":"session:main","type":"input","payload":{"data":123}}');
    // 信封合法但 data 不是合法 base64 —— 解码在 handler 内 throw 也不能带崩 Hub
    client.sendRaw('{"channel":"session:main","type":"input","payload":{"data":"!!!!"}}');

    client.sendInput("echo still_$((100+11))\r");
    await client.waitForOutput("still_111");
    client.close();
  }, 30000);
});
