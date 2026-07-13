import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_CHANNEL, sessionChannel, type SessionInfo } from "@zagent/protocol";

import { loadConfig } from "../src/config.js";
import { startHub, type RunningHub } from "../src/server.js";
import { ORIGIN, TOKEN, TestClient, tryConnect } from "./helpers.js";

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

describe("control 通道会话管理", () => {
  it("连接即收到 hello：模板、cwd 预设与会话快照", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);

    const hello = await client.waitForControl<{
      templates: { id: string }[];
      cwds: string[];
      sessions: SessionInfo[];
    }>("hello");
    expect(hello.templates.map((t) => t.id)).toEqual(["claude", "codex", "bash"]);
    expect(hello.cwds.length).toBeGreaterThan(0);
    client.close();
  });

  it("create → attach → 输入回显 → resize 生效", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);

    const id = await client.createAndAttachShell();
    client.sendInput(id, "echo tracer_$((40+2))\r");
    await client.waitForOutput(id, "tracer_42");

    client.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 101, rows: 31 });
    client.sendInput(id, "stty size\r");
    await client.waitForOutput(id, "31 101");
    client.close();
  }, 30000);

  it("未知模板 / 坏 cwd → error 信封，连接继续可用", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);

    client.send(CONTROL_CHANNEL, "create", { template: "nope", cwd: process.cwd() });
    await client.waitForControl<{ message: string }>("error", (p) => p.message.includes("模板"));

    // Windows 上 node-pty 对坏 cwd 不同步抛错，Hub 必须前置校验而不是发 created
    client.send(CONTROL_CHANNEL, "create", { template: "bash", cwd: "/no/such/dir/zagent" });
    await client.waitForControl<{ message: string }>("error", (p) => p.message.includes("工作目录"));
    expect(client.envelopes.some((e) => e.type === "created")).toBe(false);

    client.send(CONTROL_CHANNEL, "list", {});
    await client.waitFor(() => client.envelopes.some((e) => e.type === "sessions"));
    client.close();
  });

  it("两个会话并存互不干扰；重新 attach 重放 ring buffer", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);

    const a = await client.createAndAttachShell();
    const b = await client.createAndAttachShell();
    expect(b).not.toBe(a);

    client.sendInput(a, "echo only_in_$((1000+1))a\r");
    await client.waitForOutput(a, "only_in_1001a");
    client.sendInput(b, "echo only_in_$((2000+2))b\r");
    await client.waitForOutput(b, "only_in_2002b");
    // 会话隔离：a 的输出不出现在 b 的通道，反之亦然
    expect(client.outputOf(b)).not.toContain("only_in_1001a");
    expect(client.outputOf(a)).not.toContain("only_in_2002b");

    // 第二个连接 attach a：ring buffer 重放能看到历史输出
    const observer = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await observer.connect()).toBe(true);
    observer.send(CONTROL_CHANNEL, "attach", { sessionId: a });
    await observer.waitForOutput(a, "only_in_1001a");

    // detach 后不再收到新输出
    observer.send(CONTROL_CHANNEL, "detach", { sessionId: a });
    client.sendInput(a, "echo after_$((3000+3))detach\r");
    await client.waitForOutput(a, "after_3003detach");
    expect(observer.outputOf(a)).not.toContain("after_3003detach");

    observer.close();
    client.close();
  }, 30000);

  it("kill 终止进程：exit 信封 + sessions 快照同步；再次 kill 移除条目", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);

    const id = await client.createAndAttachShell();
    client.send(CONTROL_CHANNEL, "kill", { sessionId: id });

    await client.waitFor(() =>
      client.envelopes.some((e) => e.channel === sessionChannel(id) && e.type === "exit"),
    );
    await client.waitFor(() => {
      const info = client.latestSessions().find((s) => s.id === id);
      return info !== undefined && info.status === "exited";
    });

    // 对已退出的会话再 kill = 从列表移除
    client.send(CONTROL_CHANNEL, "kill", { sessionId: id });
    await client.waitFor(() => client.latestSessions().every((s) => s.id !== id));
    client.close();
  }, 30000);

  it("非法消息不致崩溃，会话继续可用", async () => {
    const client = new TestClient(wsUrl(TOKEN), ORIGIN);
    expect(await client.connect()).toBe(true);
    const id = await client.createAndAttachShell();

    client.sendRaw("not an envelope");
    client.sendRaw(`{"channel":"session:${id}","type":"input","payload":{"data":123}}`);
    // 信封合法但 data 不是合法 base64 —— 解码在 handler 内 throw 也不能带崩 Hub
    client.sendRaw(`{"channel":"session:${id}","type":"input","payload":{"data":"!!!!"}}`);
    client.send(CONTROL_CHANNEL, "kill", { sessionId: "ghost" });
    await client.waitForControl<{ message: string }>("error");

    client.sendInput(id, "echo still_$((100+11))\r");
    await client.waitForOutput(id, "still_111");
    client.close();
  }, 30000);
});
