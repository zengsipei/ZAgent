// 临时验收 UI（#17）：chat 会话的结构化消息流以日志行直出，验证 WS 通路与回放。
// 不是聊天气泡——正经聊天视图属 M2（#18），届时整体替换本组件。

import { useEffect, useRef, useState } from "react";

import {
  CONTROL_CHANNEL,
  parseHubMessage,
  serializeEnvelope,
  sessionChannel,
  type ChatItem,
  type ChatState,
  type ClientMessage,
} from "@zagent/protocol";

import { HUB_WS_URL } from "./hubUrl.js";

type StatusTone = "info" | "ok" | "error";

const STATE_LABEL: Record<ChatState, string> = {
  idle: "空闲",
  thinking: "思考中…",
  "awaiting-input": "等待输入",
};

function itemLabel(item: ChatItem): string {
  switch (item.kind) {
    case "user":
      return `[user] ${item.text}`;
    case "assistant":
      return `[assistant] ${item.text}`;
    case "tool_use":
      return `[tool_use] ${item.name} ${item.input}`;
    case "tool_result":
      return `[tool_result${item.isError ? " ✗" : ""}] ${item.text}`;
    case "system":
      return `[system] ${item.text}`;
  }
}

export function ChatDebugView({
  token,
  sessionId,
  onBack,
}: {
  token: string;
  sessionId: string;
  onBack: () => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [pending, setPending] = useState("");
  const [chatState, setChatState] = useState<ChatState>("idle");
  const [status, setStatus] = useState<{ text: string; tone: StatusTone }>({
    text: "连接中…",
    tone: "info",
  });
  const [exited, setExited] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const channel = sessionChannel(sessionId);
    let closed = false;
    let retryTimer: number | null = null;
    let ws: WebSocket;

    function connect(): void {
      ws = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        const attach: ClientMessage = {
          channel: CONTROL_CHANNEL,
          type: "attach",
          payload: { sessionId },
        };
        ws.send(serializeEnvelope(attach));
      };
      ws.onmessage = (event) => {
        const message = parseHubMessage(String(event.data));
        if (message === null) {
          return;
        }
        if (message.channel === CONTROL_CHANNEL) {
          if (message.type === "attached" && message.payload.sessionId === sessionId) {
            setStatus({ text: "已附加", tone: "ok" });
          } else if (message.type === "error") {
            setStatus({ text: message.payload.message, tone: "error" });
          }
          return;
        }
        if (message.channel !== channel) {
          return;
        }
        if (message.type === "chat-history") {
          // 重放即全量：断线期间的定稿与回合中增量一并到齐（ADR-0005）
          setItems(message.payload.items);
          setPending(message.payload.pending ?? "");
          setChatState(message.payload.state);
        } else if (message.type === "chat-item") {
          const item = message.payload.item;
          setItems((prev) => [...prev, item]);
          if (item.kind === "assistant") {
            setPending("");
          }
        } else if (message.type === "chat-delta") {
          setPending((prev) => prev + message.payload.text);
        } else if (message.type === "chat-state") {
          setChatState(message.payload.state);
          if (message.payload.state !== "thinking") {
            setPending("");
          }
        } else if (message.type === "exit") {
          setExited(message.payload.exitCode);
          setStatus({ text: `会话已退出（exit ${message.payload.exitCode}）`, tone: "error" });
        }
      };
      ws.onclose = () => {
        if (closed) {
          return;
        }
        setStatus({ text: "连接断开，重连中…", tone: "error" });
        retryTimer = window.setTimeout(connect, 1500);
      };
    }

    connect();
    return () => {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      wsRef.current = null;
      ws.close();
    };
  }, [token, sessionId]);

  // 新消息到达贴底：验收日志视图无需滚动位置记忆
  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [items, pending]);

  function handleSend(event: React.FormEvent): void {
    event.preventDefault();
    const text = draft.trim();
    const ws = wsRef.current;
    if (text === "" || ws === null || ws.readyState !== WebSocket.OPEN || exited !== null) {
      return;
    }
    const message: ClientMessage = {
      channel: sessionChannel(sessionId),
      type: "chat-input",
      payload: { text },
    };
    ws.send(serializeEnvelope(message));
    setDraft("");
  }

  return (
    <div className="chat-debug">
      <header className="chat-debug-header">
        <button type="button" onClick={onBack}>
          ← 返回
        </button>
        <span className="chat-debug-title">chat · {sessionId}</span>
        <span className="session-list-status" data-tone={status.tone}>
          {status.text} · {STATE_LABEL[chatState]}
        </span>
      </header>
      <div className="chat-debug-log" ref={logRef}>
        {items.map((item) => (
          <div key={item.id} className="chat-debug-line" data-kind={item.kind}>
            {itemLabel(item)}
          </div>
        ))}
        {pending !== "" && (
          <div className="chat-debug-line chat-debug-pending">[assistant…] {pending}</div>
        )}
        {items.length === 0 && pending === "" && (
          <div className="chat-debug-line">（暂无消息，下方输入开始对话）</div>
        )}
      </div>
      <form className="chat-debug-input" onSubmit={handleSend}>
        <input
          type="text"
          value={draft}
          placeholder={exited !== null ? "会话已退出" : "输入消息…"}
          disabled={exited !== null}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={exited !== null || draft.trim() === ""}>
          发送
        </button>
      </form>
    </div>
  );
}
