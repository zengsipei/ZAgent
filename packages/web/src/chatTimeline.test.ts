import { describe, expect, it } from "vitest";

import type { ChatItem } from "@zagent/protocol";

import { buildTimeline, formatToolInput, toolSummary } from "./chatTimeline.js";

function useItem(id: string, name = "Bash", input = "{}"): ChatItem {
  return { kind: "tool_use", id, name, input, ts: 1 };
}

function resultItem(id: string, toolUseId: string, text = "ok"): ChatItem {
  return { kind: "tool_result", id, toolUseId, text, isError: false, ts: 2 };
}

describe("buildTimeline", () => {
  it("按 toolUseId 把 result 併入 use 卡", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "m1", text: "跑一下", ts: 1 },
      useItem("toolu_1"),
      resultItem("m2", "toolu_1"),
      { kind: "assistant", id: "m3", text: "跑完了", ts: 3 },
    ];
    const timeline = buildTimeline(items);
    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      kind: "tool",
      use: { id: "toolu_1" },
      result: { id: "m2" },
    });
  });

  it("未收到 result 的 use 卡 result 为 null（运行中）", () => {
    const timeline = buildTimeline([useItem("toolu_1")]);
    expect(timeline[0]).toMatchObject({ kind: "tool", result: null });
  });

  it("配不上的 result 落成孤儿卡而不是被吞", () => {
    const timeline = buildTimeline([resultItem("m1", "toolu_missing")]);
    expect(timeline[0]).toMatchObject({ kind: "orphan-result", result: { id: "m1" } });
  });

  it("同一 use 的第二条 result 落成孤儿卡", () => {
    const timeline = buildTimeline([
      useItem("toolu_1"),
      resultItem("m2", "toolu_1"),
      resultItem("m3", "toolu_1"),
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({ kind: "orphan-result", result: { id: "m3" } });
  });

  it("user / assistant / system 原样透传且保持顺序", () => {
    const items: ChatItem[] = [
      { kind: "system", id: "m1", text: "异常", ts: 1 },
      { kind: "user", id: "m2", text: "hi", ts: 2 },
      { kind: "assistant", id: "m3", text: "hello", ts: 3 },
    ];
    expect(buildTimeline(items).map((e) => e.kind)).toEqual(["system", "user", "assistant"]);
  });
});

describe("toolSummary", () => {
  it("优先取 command 字段", () => {
    expect(toolSummary('{"command":"git status","description":"看状态"}')).toBe("git status");
  });

  it("次选 file_path 等字段", () => {
    expect(toolSummary('{"file_path":"src/App.tsx"}')).toBe("src/App.tsx");
  });

  it("空对象给空摘要（只显示工具名）", () => {
    expect(toolSummary("{}")).toBe("");
  });

  it("未知字段退回 JSON 原串截断", () => {
    expect(toolSummary('{"foo":1}')).toBe('{"foo":1}');
  });

  it("坏 JSON（Hub 截断致残）原样截断", () => {
    const broken = '{"command":"echo …（已截断）';
    expect(toolSummary(broken)).toBe(broken);
  });

  it("超长值截断且压掉换行", () => {
    const long = `a\n${"b".repeat(200)}`;
    const summary = toolSummary(JSON.stringify({ command: long }));
    expect(summary.length).toBeLessThanOrEqual(97);
    expect(summary).not.toContain("\n");
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("formatToolInput", () => {
  it("合法 JSON pretty-print", () => {
    expect(formatToolInput('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("坏 JSON 原样返回", () => {
    expect(formatToolInput("{oops")).toBe("{oops");
  });
});
