import { useEffect, useRef, useState } from "react";

import {
  CONTROL_CHANNEL,
  parseHubMessage,
  serializeEnvelope,
  type ClientMessage,
  type SessionInfo,
  type SessionTemplate,
} from "@zagent/protocol";

import { HUB_WS_URL } from "./hubUrl.js";

const CUSTOM_CWD = "__custom__";

interface HelloData {
  templates: SessionTemplate[];
  cwds: string[];
}

/**
 * 会话列表页：展示 Hub 管理的全部会话（模板、cwd、运行状态），
 * 提供新建（模板 × cwd）与 kill。全部操作走 control 通道信封（ADR-0004）。
 */
export function SessionListView({
  token,
  onOpen,
}: {
  token: string;
  onOpen: (sessionId: string) => void;
}) {
  const [hello, setHello] = useState<HelloData | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [template, setTemplate] = useState("claude");
  const [cwdChoice, setCwdChoice] = useState("");
  const [customCwd, setCustomCwd] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const ws = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      const message = parseHubMessage(String(event.data));
      if (message === null) {
        return;
      }
      if (message.type === "hello") {
        setConnected(true);
        setHello({ templates: message.payload.templates, cwds: message.payload.cwds });
        setSessions(message.payload.sessions);
        setCwdChoice((prev) => (prev === "" ? (message.payload.cwds[0] ?? CUSTOM_CWD) : prev));
      } else if (message.type === "sessions") {
        setSessions(message.payload.sessions);
      } else if (message.type === "created") {
        // 自己发起的 create 成功：直接进入终端页
        onOpenRef.current(message.payload.session.id);
      } else if (message.type === "error") {
        setCreating(false);
        setError(message.payload.message);
      }
    };
    ws.onclose = () => {
      setConnected(false);
      setError((prev) => prev ?? "连接已关闭（token/Origin 校验不通过或 Hub 未启动）");
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [token]);

  function sendControl(message: ClientMessage): void {
    const ws = wsRef.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(serializeEnvelope(message));
    }
  }

  function handleCreate(event: React.FormEvent): void {
    event.preventDefault();
    const cwd = cwdChoice === CUSTOM_CWD ? customCwd.trim() : cwdChoice;
    if (cwd === "") {
      setError("请填写工作目录");
      return;
    }
    setError(null);
    setCreating(true);
    sendControl({ channel: CONTROL_CHANNEL, type: "create", payload: { template, cwd } });
  }

  function handleKill(sessionId: string): void {
    sendControl({ channel: CONTROL_CHANNEL, type: "kill", payload: { sessionId } });
  }

  return (
    <div className="session-list">
      <header className="session-list-header">
        <h1>ZAgent 会话</h1>
        <span className="session-list-status" data-tone={connected ? "ok" : "error"}>
          {connected ? "已连接" : "未连接"}
        </span>
      </header>

      {error !== null && <p className="session-list-error">{error}</p>}

      <ul className="session-items">
        {sessions.length === 0 && <li className="session-empty">暂无会话，从下方新建一个</li>}
        {sessions.map((s) => (
          <li key={s.id} className="session-item" data-status={s.status}>
            <button
              type="button"
              className="session-item-main"
              disabled={s.status !== "running"}
              onClick={() => onOpen(s.id)}
            >
              <span className="session-item-command">{s.command}</span>
              <span className="session-item-meta">
                {s.cwd} · {s.status === "running" ? "运行中" : `已退出（exit ${s.exitCode ?? "?"}）`}
              </span>
            </button>
            <button
              type="button"
              className="session-item-kill"
              onClick={() => handleKill(s.id)}
              aria-label={s.status === "running" ? "杀死会话" : "移除记录"}
            >
              {s.status === "running" ? "杀死" : "移除"}
            </button>
          </li>
        ))}
      </ul>

      <form className="session-create" onSubmit={handleCreate}>
        <h2>新建会话</h2>
        <div className="session-create-templates" role="radiogroup" aria-label="命令模板">
          {(hello?.templates ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={template === t.id}
              data-selected={template === t.id || undefined}
              onClick={() => setTemplate(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
        <label>
          工作目录
          <select value={cwdChoice} onChange={(e) => setCwdChoice(e.target.value)}>
            {(hello?.cwds ?? []).map((cwd) => (
              <option key={cwd} value={cwd}>
                {cwd}
              </option>
            ))}
            <option value={CUSTOM_CWD}>手动输入…</option>
          </select>
        </label>
        {cwdChoice === CUSTOM_CWD && (
          <input
            type="text"
            placeholder="/path/to/project"
            value={customCwd}
            onChange={(e) => setCustomCwd(e.target.value)}
            autoFocus
          />
        )}
        <button type="submit" className="session-create-submit" disabled={!connected || creating}>
          {creating ? "创建中…" : "创建并进入"}
        </button>
      </form>
    </div>
  );
}
