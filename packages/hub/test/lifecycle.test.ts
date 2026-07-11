// Issue #4 验收：断线不杀、重连重放、attach 后 resize 抖动、多端双向输入。

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_CHANNEL, sessionChannel } from "@zagent/protocol";

import { loadConfig } from "../src/config.js";
import { startHub, type RunningHub } from "../src/server.js";
import { NUDGE_AFTER_ATTACH_DELAY_MS, NUDGE_RESTORE_DELAY_MS } from "../src/session.js";
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

describe("会话生命周期（ADR-0005）", () => {
  it("连接异常断开 30 秒以上，后台任务不中断；重新 attach 重放恢复画面", async () => {
    const first = new TestClient(url(), ORIGIN);
    expect(await first.connect()).toBe(true);
    const id = await first.createAndAttachShell();

    // 后台长任务：31 秒后才产出结果；随即模拟断网（不发 close 帧直接掐断 TCP）
    first.sendInput(id, "echo before_$((5000+5))disconnect; sleep 31 && echo survived_$((6000+6))s\r");
    await first.waitForOutput(id, "before_5005disconnect");
    first.destroy();

    // 无人连接期间进程继续跑；新连接 attach 后：重放看到断线前输出，live 流收到断线期间任务的结果
    const second = new TestClient(url(), ORIGIN);
    expect(await second.connect()).toBe(true);
    second.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    await second.waitForOutput(id, "before_5005disconnect");
    await second.waitForOutput(id, "survived_6006s", 40000);

    // 进程仍可交互
    second.sendInput(id, "echo alive_$((7000+7))\r");
    await second.waitForOutput(id, "alive_7007");
    second.close();
  }, 60000);

  it("attach 触发 resize 抖动（前台程序收到 WINCH），且尺寸随后恢复", async () => {
    const first = new TestClient(url(), ORIGIN);
    expect(await first.connect()).toBe(true);
    const id = await first.createAndAttachShell();

    first.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 97, rows: 33 });
    await first.probeOutput(id, "stty size\r", "33 97");
    // $(( )) 让命令回显（WINCH_$((...））与实际输出（WINCH_21）可区分
    first.sendInput(id, "trap 'echo WINCH_$((10#7*3))' WINCH\r");
    await first.probeOutput(id, "echo trap_$((800+88))ready\r", "trap_888ready");

    // 第二连接 attach → 服务端延迟抖动 → 前台 bash 收到 WINCH。
    // attach 后立刻回发相同尺寸 resize，模拟真实前端行为：相同尺寸不得打断抖动。
    // ConPTY 偶发吞 resize 事件，轮询里重发 attach（幂等，每次 attach 重新排期抖动）
    const second = new TestClient(url(), ORIGIN);
    expect(await second.connect()).toBe(true);
    await retryUntil(
      () => {
        second.send(CONTROL_CHANNEL, "attach", { sessionId: id });
        second.send(CONTROL_CHANNEL, "resize", { sessionId: id, cols: 97, rows: 33 });
      },
      () => first.outputOf(id).includes("WINCH_21"),
      { message: "attach 抖动未触发 WINCH" },
    );

    // 抖动恢复后尺寸回到原值（等恢复定时器落地；重发 stty 消除 ConPTY 时序抖动）
    await new Promise((r) => setTimeout(r, NUDGE_AFTER_ATTACH_DELAY_MS + NUDGE_RESTORE_DELAY_MS));
    const before = first.outputOf(id).length;
    await retryUntil(
      () => first.sendInput(id, "stty size\r"),
      () => first.outputOf(id).indexOf("33 97", before) !== -1,
      { message: "抖动后尺寸未恢复到 97x33" },
    );
    second.close();
    first.close();
  }, 30000);

  it("两个连接同时 attach：双端看到相同输出，任一端可输入", async () => {
    const a = new TestClient(url(), ORIGIN);
    const b = new TestClient(url(), ORIGIN);
    expect(await a.connect()).toBe(true);
    expect(await b.connect()).toBe(true);

    const id = await a.createAndAttachShell();
    b.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    await b.waitForControl("attached");

    await a.probeOutput(id, "echo from_$((100+1))a\r", "from_101a");
    await b.waitForOutput(id, "from_101a");

    await b.probeOutput(id, "echo from_$((200+2))b\r", "from_202b");
    await a.waitForOutput(id, "from_202b");

    a.close();
    b.close();
  }, 30000);

  it("attach 已退出的会话：重放后补发 exit，重连端不会误以为会话还活着", async () => {
    const first = new TestClient(url(), ORIGIN);
    expect(await first.connect()).toBe(true);
    const id = await first.createAndAttachShell();
    first.sendInput(id, "echo last_$((900+9))words; exit\r");
    await first.waitFor(() =>
      first.envelopes.some((e) => e.channel === sessionChannel(id) && e.type === "exit"),
    );
    first.destroy();

    // 退出瞬间不在场的连接，attach 时也要得知会话已死
    const second = new TestClient(url(), ORIGIN);
    expect(await second.connect()).toBe(true);
    second.send(CONTROL_CHANNEL, "attach", { sessionId: id });
    await second.waitForOutput(id, "last_909words");
    await second.waitFor(() =>
      second.envelopes.some((e) => e.channel === sessionChannel(id) && e.type === "exit"),
    );
    second.close();
  }, 30000);
});
