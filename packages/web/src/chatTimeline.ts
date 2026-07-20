// 聊天时间线的渲染前整形（#18）：ChatItem 流 → 渲染单元。
// tool_use 与 tool_result 凭 toolUseId 合并成一张工具卡；纯函数，无 DOM 依赖。

import type { ChatItem } from "@zagent/protocol";

export type ToolUseItem = Extract<ChatItem, { kind: "tool_use" }>;
export type ToolResultItem = Extract<ChatItem, { kind: "tool_result" }>;

export type TimelineEntry =
  | { kind: "user"; item: Extract<ChatItem, { kind: "user" }> }
  | { kind: "assistant"; item: Extract<ChatItem, { kind: "assistant" }> }
  | { kind: "system"; item: Extract<ChatItem, { kind: "system" }> }
  | { kind: "tool"; use: ToolUseItem; result: ToolResultItem | null }
  | { kind: "orphan-result"; result: ToolResultItem };

/**
 * tool_result 併入对应 tool_use 卡；配不上的（历史截断丢了 use、或同 use 收到第二条
 * result）落成孤儿卡而不是吞掉——时间线不丢信息。
 */
export function buildTimeline(items: ChatItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const openTools = new Map<string, Extract<TimelineEntry, { kind: "tool" }>>();
  for (const item of items) {
    switch (item.kind) {
      case "tool_use": {
        const entry: Extract<TimelineEntry, { kind: "tool" }> = {
          kind: "tool",
          use: item,
          result: null,
        };
        entries.push(entry);
        openTools.set(item.id, entry);
        break;
      }
      case "tool_result": {
        const open = openTools.get(item.toolUseId);
        if (open !== undefined && open.result === null) {
          open.result = item;
        } else {
          entries.push({ kind: "orphan-result", result: item });
        }
        break;
      }
      default:
        entries.push({ kind: item.kind, item } as TimelineEntry);
    }
  }
  return entries;
}

// 摘要字段优先级：覆盖内置工具的高频形态（Bash.command / Read.file_path /
// Grep.pattern / WebFetch.url …），MCP 等未知工具退回原始 JSON 截断
const SUMMARY_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
] as const;

const SUMMARY_MAX = 96;

function ellipsis(text: string, max: number): string {
  const oneLine = text.replaceAll(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 工具卡摘要行：从 input JSON 提取最能代表这次调用的一个值；提不出就截原串。 */
export function toolSummary(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return ellipsis(input, SUMMARY_MAX);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return ellipsis(input, SUMMARY_MAX);
  }
  const record = parsed as Record<string, unknown>;
  for (const field of SUMMARY_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") {
      return ellipsis(value, SUMMARY_MAX);
    }
  }
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return "";
  }
  return ellipsis(input, SUMMARY_MAX);
}

/** 工具卡详情里的 input 展示：能 parse 就 pretty-print，不能（Hub 截断致残）原样给。 */
export function formatToolInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}
