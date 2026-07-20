import { describe, expect, it } from "vitest";

import { StreamJsonInterpreter } from "./chatSession.js";

// 事件样例对齐 spike #16 实测的 stream-json 形态（claude CLI 2.1.x）
const now = () => 1751900000000;

describe("StreamJsonInterpreter（stream-json 事件 → 时间线效果）", () => {
  it("system/init → claude-session-id", () => {
    const itp = new StreamJsonInterpreter(now);
    expect(
      itp.interpret(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })),
    ).toEqual([{ effect: "claude-session-id", claudeSessionId: "abc-123" }]);
    expect(itp.interpret(JSON.stringify({ type: "system", subtype: "other" }))).toEqual([]);
  });

  it("stream_event 的 text_delta → delta；thinking/tool 参数增量与子 agent 增量不转发", () => {
    const itp = new StreamJsonInterpreter(now);
    const wrap = (delta: unknown, parent: string | null = null) =>
      JSON.stringify({
        type: "stream_event",
        parent_tool_use_id: parent,
        event: { type: "content_block_delta", index: 0, delta },
      });
    expect(itp.interpret(wrap({ type: "text_delta", text: "你好" }))).toEqual([
      { effect: "delta", text: "你好" },
    ]);
    expect(itp.interpret(wrap({ type: "thinking_delta", thinking: "嗯" }))).toEqual([]);
    expect(itp.interpret(wrap({ type: "input_json_delta", partial_json: "{\"c" }))).toEqual([]);
    expect(itp.interpret(wrap({ type: "text_delta", text: "旁支" }, "toolu_01"))).toEqual([]);
  });

  it("assistant 事件：text 与 tool_use 各成条目，tool_use 沿用 CLI 的 id", () => {
    const itp = new StreamJsonInterpreter(now);
    const effects = itp.interpret(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "…" },
            { type: "text", text: "我来看看" },
            { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(effects).toEqual([
      { effect: "item", item: { kind: "assistant", id: "m1", text: "我来看看", ts: now() } },
      {
        effect: "item",
        item: { kind: "tool_use", id: "toolu_01", name: "Bash", input: '{"command":"ls"}', ts: now() },
      },
    ]);
  });

  it("user 事件：tool_result 成条目（字符串与块数组内容都认），text 回显跳过", () => {
    const itp = new StreamJsonInterpreter(now);
    const stringResult = itp.interpret(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "a.txt\nb.txt" }],
        },
      }),
    );
    expect(stringResult).toEqual([
      {
        effect: "item",
        item: { kind: "tool_result", id: "m1", toolUseId: "toolu_01", text: "a.txt\nb.txt", isError: false, ts: now() },
      },
    ]);
    const blockResult = itp.interpret(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_02",
              content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }],
              is_error: true,
            },
          ],
        },
      }),
    );
    expect(blockResult[0]).toEqual({
      effect: "item",
      item: { kind: "tool_result", id: "m2", toolUseId: "toolu_02", text: "第一段\n第二段", isError: true, ts: now() },
    });
    // 自己输入的回显：Hub 发送时已定稿，不能重复
    expect(
      itp.interpret(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "你好" }] },
        }),
      ),
    ).toEqual([]);
  });

  it("result 事件：success → 无错误收口；error → 带错误文本收口", () => {
    const itp = new StreamJsonInterpreter(now);
    expect(
      itp.interpret(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "好的" })),
    ).toEqual([{ effect: "turn-end", errorText: null }]);
    expect(
      itp.interpret(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true })),
    ).toEqual([{ effect: "turn-end", errorText: "回合异常结束（error_during_execution）" }]);
    expect(
      itp.interpret(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "达到轮次上限" })),
    ).toEqual([{ effect: "turn-end", errorText: "达到轮次上限" }]);
  });

  it("非 JSON、非对象、未知类型的行一律安静丢弃", () => {
    const itp = new StreamJsonInterpreter(now);
    expect(itp.interpret("not json")).toEqual([]);
    expect(itp.interpret("42")).toEqual([]);
    expect(itp.interpret(JSON.stringify({ type: "mystery" }))).toEqual([]);
  });

  it("超长文本按上限截断（时间线缓冲健康优先）", () => {
    const itp = new StreamJsonInterpreter(now);
    const long = "x".repeat(5000);
    const [eff] = itp.interpret(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: long }] } }),
    );
    if (eff?.effect !== "item" || eff.item.kind !== "assistant") {
      throw new Error("expected assistant item");
    }
    expect(eff.item.text.length).toBeLessThan(5000);
    expect(eff.item.text.endsWith("…（已截断）")).toBe(true);
  });

  it("userItem / systemItem 工厂与事件条目共用一套 id 序列", () => {
    const itp = new StreamJsonInterpreter(now);
    const user = itp.userItem("你好");
    itp.interpret(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "嗨" }] } }),
    );
    const system = itp.systemItem("已退出");
    expect(user.id).toBe("m1");
    expect(system.id).toBe("m3");
  });
});
