// 聊天视图（#18）：chat 会话的气泡时间线 + 流式渲染 + 常驻输入条。
// 键盘适配的全部答案是「没有适配」：普通 textarea + 文档流布局，键盘可见性由
// viewport meta 的 interactive-widget=resizes-content 与浏览器原生行为保证——
// 这里禁止出现任何键盘检测（visualViewport / VirtualKeyboard / 高度估算，#7 教训）。

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  CONTROL_CHANNEL,
  parseHubMessage,
  serializeEnvelope,
  sessionChannel,
  type ChatItem,
  type ChatState,
  type ClientMessage,
} from "@zagent/protocol";

import {
  buildTimeline,
  formatToolInput,
  toolSummary,
  type TimelineEntry,
  type ToolResultItem,
  type ToolUseItem,
} from "./chatTimeline.js";
import { HUB_WS_URL } from "./hubUrl.js";

type StatusTone = "info" | "ok" | "error";

// 桌面才有 Enter 发送（Shift+Enter 换行）；触屏上 Enter 一律换行，发送靠按钮——
// 移动端 IME 的 Enter 语义不可劫持
function hasDesktopKeyboard(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

// ---------------------------------------------------------------------------
// 时间线条目渲染。全部 memo：定稿条目内容不可变（item 引用在 items 数组里稳定），
// 流式期间高频重渲染被浅比较挡在 markdown 解析之外。
// ---------------------------------------------------------------------------

// 链接必须开新窗口：PWA 单页就是会话本身，原地导航等于杀掉聊天页面
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

const UserMessage = memo(function UserMessage({
  item,
}: {
  item: Extract<ChatItem, { kind: "user" }>;
}) {
  return (
    <div className="chat-row chat-row--user">
      <div className="chat-bubble-user">{item.text}</div>
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  item,
}: {
  item: Extract<ChatItem, { kind: "assistant" }>;
}) {
  return (
    <div className="chat-row">
      <Markdown text={item.text} />
    </div>
  );
});

const SystemNote = memo(function SystemNote({
  item,
}: {
  item: Extract<ChatItem, { kind: "system" }>;
}) {
  return <div className="chat-system">{item.text}</div>;
});

// 工具卡：默认折叠只露「名称 + 摘要 + 状态」，点开看完整 input / result。
// <details> 非受控——展开态住在 DOM 里，memo 跳过的重渲染不会把它折回去
const ToolCard = memo(function ToolCard({
  use,
  result,
}: {
  use: ToolUseItem;
  result: ToolResultItem | null;
}) {
  const state = result === null ? "running" : result.isError ? "error" : "done";
  return (
    <details className="chat-tool" data-state={state}>
      <summary>
        <span className="chat-tool-dot" aria-hidden="true" />
        <span className="chat-tool-name">{use.name}</span>
        <span className="chat-tool-summary">{toolSummary(use.input)}</span>
      </summary>
      <div className="chat-tool-detail">
        <pre className="chat-tool-io">{formatToolInput(use.input)}</pre>
        {result === null ? (
          <p className="chat-tool-pending">运行中…</p>
        ) : (
          result.text !== "" && (
            <pre className="chat-tool-io" data-error={result.isError || undefined}>
              {result.text}
            </pre>
          )
        )}
      </div>
    </details>
  );
});

// 孤儿 result（历史截断丢了 use / 同 use 第二条 result）：单独成卡，不吞数据
const OrphanResultCard = memo(function OrphanResultCard({ result }: { result: ToolResultItem }) {
  return (
    <details className="chat-tool" data-state={result.isError ? "error" : "done"}>
      <summary>
        <span className="chat-tool-dot" aria-hidden="true" />
        <span className="chat-tool-name">工具结果</span>
        <span className="chat-tool-summary">{toolSummary(result.text)}</span>
      </summary>
      <div className="chat-tool-detail">
        <pre className="chat-tool-io" data-error={result.isError || undefined}>
          {result.text}
        </pre>
      </div>
    </details>
  );
});

function EntryView({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case "user":
      return <UserMessage item={entry.item} />;
    case "assistant":
      return <AssistantMessage item={entry.item} />;
    case "system":
      return <SystemNote item={entry.item} />;
    case "tool":
      return <ToolCard use={entry.use} result={entry.result} />;
    case "orphan-result":
      return <OrphanResultCard result={entry.result} />;
  }
}

function entryKey(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "tool":
      return entry.use.id;
    case "orphan-result":
      return entry.result.id;
    default:
      return entry.item.id;
  }
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function ChatView({
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
  const [attached, setAttached] = useState(false);
  const [exited, setExited] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // 贴底跟随：在底部附近时新内容自动贴底；上翻看历史则不打扰，露「回到最新」。
  // ref 是滚动 effect 读的真相，state 只管按钮显隐
  const [stuck, setStuck] = useState(true);
  const stickRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  function scrollToBottom(): void {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }

  useEffect(() => {
    const channel = sessionChannel(sessionId);
    let ws: WebSocket | null = null;
    let disposed = false;
    let sessionExited = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleReconnect(): void {
      if (disposed || sessionExited || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      setStatus({ text: `连接断开，${Math.round(delay / 1000)} 秒后重连…`, tone: "error" });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed) {
        return;
      }
      setStatus({
        text: reconnectAttempt === 0 ? "连接中…" : `重连中…（第 ${reconnectAttempt} 次）`,
        tone: "info",
      });
      const socket = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
      ws = socket;
      wsRef.current = socket;
      socket.onopen = () => {
        const attach: ClientMessage = {
          channel: CONTROL_CHANNEL,
          type: "attach",
          payload: { sessionId },
        };
        socket.send(serializeEnvelope(attach));
      };
      socket.onmessage = (event) => {
        const message = parseHubMessage(String(event.data));
        if (message === null) {
          return;
        }
        if (message.channel === CONTROL_CHANNEL) {
          if (message.type === "attached" && message.payload.sessionId === sessionId) {
            reconnectAttempt = 0;
            setAttached(true);
            setStatus({ text: "已连接", tone: "ok" });
          } else if (message.type === "error") {
            setStatus({ text: message.payload.message, tone: "error" });
          }
          return;
        }
        if (message.channel !== channel) {
          return;
        }
        if (message.type === "chat-history") {
          // 重放即全量（ADR-0005）：断线期间的定稿与回合中增量一并到齐，直接覆盖本地
          stickRef.current = true;
          setStuck(true);
          setItems(message.payload.items);
          setPending(message.payload.pending ?? "");
          setChatState(message.payload.state);
        } else if (message.type === "chat-item") {
          const item = message.payload.item;
          setItems((prev) => [...prev, item]);
          // assistant 定稿包含全文，覆盖打字机预览
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
          sessionExited = true;
          setExited(message.payload.exitCode);
          setAttached(false);
          setStatus({ text: `会话已退出（exit ${message.payload.exitCode}）`, tone: "error" });
        }
      };
      socket.onclose = () => {
        if (disposed || sessionExited) {
          return;
        }
        setAttached(false);
        scheduleReconnect();
      };
    }

    connect();

    // 回前台/网络恢复不等退避定时器：锁屏期间定时器被节流且退避可能已攀升，直接清零重连
    function reconnectNow(): void {
      if (disposed || sessionExited) {
        return;
      }
      reconnectAttempt = 0;
      if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        reconnectNow();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", reconnectNow);

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", reconnectNow);
      wsRef.current = null;
      ws?.close();
    };
  }, [token, sessionId]);

  // 新内容贴底跟随（instant：流式高频下 smooth 追不上）
  useLayoutEffect(() => {
    if (stickRef.current) {
      scrollToBottom();
    }
  }, [items, pending, chatState]);

  // 容器尺寸变化（键盘弹出 resizes-content 收缩布局、转屏）时维持贴底：
  // 这是键盘弹出后最后一条消息不被「藏进键盘后面」的保证
  useEffect(() => {
    const log = logRef.current;
    if (log === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (stickRef.current) {
        scrollToBottom();
      }
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  function handleScroll(event: React.UIEvent<HTMLDivElement>): void {
    const log = event.currentTarget;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    stickRef.current = nearBottom;
    setStuck(nearBottom);
  }

  function send(): void {
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
    stickRef.current = true;
    setStuck(true);
    scrollToBottom();
  }

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    // IME 组合中的 Enter 是选词，不是发送
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (hasDesktopKeyboard()) {
      event.preventDefault();
      send();
    }
  }

  const timeline = useMemo(() => buildTimeline(items), [items]);
  const showThinking = chatState === "thinking" && pending === "" && exited === null;
  const canSend = attached && exited === null && draft.trim() !== "";

  return (
    <div className="chat">
      <div className="status-bar" data-tone={status.tone}>
        <button type="button" className="status-back" onClick={onBack} aria-label="返回会话列表">
          ‹ 列表
        </button>
        <span className="status-dot" aria-hidden="true" />
        {status.text}
        {chatState === "awaiting-input" && exited === null && (
          <span className="chat-state-badge">等待确认</span>
        )}
      </div>

      <div className="chat-log-wrap">
        <div className="chat-log" ref={logRef} onScroll={handleScroll}>
          <div className="chat-log-inner">
            {timeline.length === 0 && pending === "" && !showThinking && (
              <p className="chat-empty">
                {exited !== null ? "会话已退出" : "暂无消息，下方输入开始对话"}
              </p>
            )}
            {timeline.map((entry) => (
              <EntryView key={entryKey(entry)} entry={entry} />
            ))}
            {pending !== "" && (
              <div className="chat-row">
                <Markdown text={`${pending}▍`} />
              </div>
            )}
            {showThinking && (
              <div className="chat-thinking" aria-label="生成中">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </div>
        {!stuck && (
          <button
            type="button"
            className="chat-jump"
            aria-label="回到最新消息"
            onClick={() => {
              stickRef.current = true;
              setStuck(true);
              scrollToBottom();
            }}
          >
            ↓
          </button>
        )}
      </div>

      <form className="chat-composer" onSubmit={handleSubmit}>
        <textarea
          rows={1}
          value={draft}
          placeholder={exited !== null ? "会话已退出" : "发消息…"}
          disabled={exited !== null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" disabled={!canSend} aria-label="发送">
          发送
        </button>
      </form>
    </div>
  );
}
