// Issue #9 验收：多端容量最小交集——resize 语义为容量上报，Hub 取各端 min；
// attached 携带会话当前尺寸；有效尺寸变化广播 resized；端离开后重算恢复。

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_CHANNEL, sessionChannel, type AttachedPayload } from "@zagent/protocol";

import { loadConfig } from "../src/config.js";
import { startHub, type RunningHub } from "../src/server.js";
import { ORIGIN, TOKEN, TestClient, retryUntil } from "./helpers.js";

let hub: RunningHub;

beforeAll(async () => {
  hub = await startHub(loadConfig({ ZAGENT_TOKEN: TOKEN, ZAGENT_PORT: "0" }));
});

afterAll(async () => {
  await hub.close();
});

function url(): string {
  return `ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`;
}

function lastResized(client: TestClient, id: string): { cols: number; rows: number } | undefined {
  for (let i = client.envelopes.length - 1; i >= 0; i--) {
    const env = client.envelopes[i]!;
    if (env.channel === sessionChannel(id) && env.type === "resized") {
      return env.payload as { cols: number; rows: number };
    }
  }
  return undefined;
}

function waitResized(client: TestClient, id: string, cols: number, rows: number): Promise<void> {
  return client.waitFor(() => {
    const size = lastResized(client, id);
    return size !== undefined && size.cols === cols && size.rows === rows;
  });
}

describe("会话尺寸最小交集（#9）", () => {
  it("attached 信封携带会话当前尺寸", async () => {
    const first = new TestClient(url(), ORIGIN);
    expect(await first.connect()).toBe(true);
    const id = await first.createAndAttachShell();

    // 初始 attach：默认 80x24
    const initial = first.envelopes.find((e) => e.type === "attached")!.payload as AttachedPayload;
    expect(initial.cols).toBe(80);
    expect(initial.rows).toBe(24);

    // 容量上报改变有效尺寸后，新 attach 端立刻拿到当前尺寸
    first.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 91, rows: 29 });
    await waitResized(first, id, 91, 29);

    const second = new TestClient(url(), ORIGIN);
    expect(await second.connect()).toBe(true);
    second.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    const attached = await second.waitForControl<AttachedPayload>("attached");
    expect(attached.cols).toBe(91);
    expect(attached.rows).toBe(29);

    second.close();
    first.close();
  }, 30000);

  it("两连接不同容量：PTY 取 min 且双方收到 resized；小端离开后自动恢复", async () => {
    const wide = new TestClient(url(), ORIGIN);
    expect(await wide.connect()).toBe(true);
    const id = await wide.createAndAttachShell();
    wide.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 121, rows: 41 });
    await waitResized(wide, id, 121, 41);

    // 窄端 attach 并上报较小容量：有效尺寸变为逐维 min（cols 取窄端，rows 取宽端）
    const narrow = new TestClient(url(), ORIGIN);
    expect(await narrow.connect()).toBe(true);
    narrow.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    await narrow.waitForControl("attached");
    narrow.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 101, rows: 51 });
    await waitResized(wide, id, 101, 41);
    await waitResized(narrow, id, 101, 41);
    await wide.probeOutput(id, "stty size\r", "41 101");

    // 窄端异常断开：剩余端容量重新成为有效尺寸，留下的端收到 resized
    narrow.destroy();
    await waitResized(wide, id, 121, 41);
    const before = wide.outputOf(id).length;
    await retryUntil(
      () => wide.sendInput(id, "stty size\r"),
      () => wide.outputOf(id).indexOf("41 121", before) !== -1,
      { message: "窄端离开后 PTY 未恢复 121x41" },
    );
    wide.close();
  }, 30000);

  it("窄端 detach 与容量再上报同样触发重算", async () => {
    const a = new TestClient(url(), ORIGIN);
    expect(await a.connect()).toBe(true);
    const id = await a.createAndAttachShell();
    a.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 111, rows: 31 });
    await waitResized(a, id, 111, 31);

    const b = new TestClient(url(), ORIGIN);
    expect(await b.connect()).toBe(true);
    b.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    await b.waitForControl("attached");
    b.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 81, rows: 21 });
    await waitResized(a, id, 81, 21);

    // 容量变化（如转屏）：同端再上报，重算生效
    b.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 91, rows: 26 });
    await waitResized(a, id, 91, 26);

    // 正常 detach 同样恢复
    b.send(CONTROL_CHANNEL, "detach", { sessionId: id });
    await waitResized(a, id, 111, 31);
    b.close();
    a.close();
  }, 30000);
});
