import { useEffect, useState } from "react";

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

// 终端页路由持久化在 hash（#/s/<id>）：移动端锁屏后浏览器可能把页面整页回收重载，
// 内存路由会把用户踢回列表页；hash 让 reload 直接回到原会话，靠重放恢复画面
function sessionIdFromHash(): string | null {
  const match = /^#\/s\/(.+)$/.exec(window.location.hash);
  return match === null ? null : decodeURIComponent(match[1]!);
}

export function App() {
  const [token, setToken] = useState<string | null>(resolveInitialToken);
  const [draft, setDraft] = useState("");
  // null = 会话列表页，非 null = 该会话的终端页；hash 是事实源
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionIdFromHash);

  useEffect(() => {
    const sync = (): void => setActiveSessionId(sessionIdFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

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
    return (
      <SessionListView
        token={token}
        onOpen={(id) => {
          // 赋值 hash 会入历史栈：手机返回手势一次回列表，hashchange 同步 state
          window.location.hash = `/s/${encodeURIComponent(id)}`;
        }}
      />
    );
  }
  return (
    <TerminalView
      token={token}
      sessionId={activeSessionId}
      onBack={() => {
        // replaceState 清 hash 不触发 hashchange，手动同步；不用 history.back()：
        // reload 后直接落在终端页时栈里没有列表页可回
        history.replaceState(null, "", window.location.pathname + window.location.search);
        setActiveSessionId(null);
      }}
    />
  );
}
