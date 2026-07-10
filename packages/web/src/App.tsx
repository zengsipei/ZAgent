import { useState } from "react";

import { SessionListView } from "./SessionListView.js";
import { TerminalView } from "./TerminalView.js";

const TOKEN_STORAGE_KEY = "zagent-token";

// token 优先取 URL ?token=（随手从 Hub 日志复制粘贴的入口），
// 存入 localStorage 后立即从地址栏抹掉，避免留在历史记录里。
function resolveInitialToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl !== null && fromUrl !== "") {
    localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    url.searchParams.delete("token");
    history.replaceState(null, "", url);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function App() {
  const [token, setToken] = useState<string | null>(resolveInitialToken);
  const [draft, setDraft] = useState("");
  // null = 会话列表页，非 null = 该会话的终端页
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  if (token === null) {
    return (
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft !== "") {
            localStorage.setItem(TOKEN_STORAGE_KEY, draft);
            setToken(draft);
          }
        }}
      >
        <label htmlFor="token">粘贴 Hub 的 ZAGENT_TOKEN（或用 ?token= 打开本页）</label>
        <input
          id="token"
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
        />
        <button type="submit">连接</button>
      </form>
    );
  }

  if (activeSessionId === null) {
    return <SessionListView token={token} onOpen={setActiveSessionId} />;
  }
  return (
    <TerminalView
      token={token}
      sessionId={activeSessionId}
      onBack={() => setActiveSessionId(null)}
    />
  );
}
