import { useEffect, useState } from "react";

import type { SessionType } from "@zagent/protocol";

import { ChatDebugView } from "./ChatDebugView.js";
import { SessionListView } from "./SessionListView.js";
import { TerminalView } from "./TerminalView.js";

const TOKEN_STORAGE_KEY = "zagent-token";

// 应用层完整认证（ADR-0007）：粘贴的根 token 只用于向 Hub 换发有期限的会话 token，
// localStorage 里持久化的是会话 token——公网形态下泄露面有界，到期回根凭证重登。
async function exchangeToken(rootToken: string): Promise<string | null> {
  try {
    const res = await fetch("/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rootToken }),
    });
    if (!res.ok) {
      return null;
    }
    const { token } = (await res.json()) as { token: string };
    return token;
  } catch {
    return null;
  }
}

// 已存 token 是否仍有效。Hub 不可达（离线、本地开发未起 Hub）不算失效，
// 不因网络问题登出——WS 层自会重试。
async function checkToken(token: string): Promise<"ok" | "invalid" | "unreachable"> {
  try {
    const res = await fetch("/auth/check", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      return "invalid";
    }
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

// 终端/聊天页路由持久化在 hash（#/s/<id> = pty 终端，#/c/<id> = chat）：移动端锁屏后
// 浏览器可能把页面整页回收重载，内存路由会把用户踢回列表页；hash 让 reload 直接
// 回到原会话，靠重放恢复画面。前缀区分会话类型，reload 后无需先问 Hub 就能选对视图
interface ActiveSession {
  kind: SessionType;
  id: string;
}

function sessionFromHash(): ActiveSession | null {
  const match = /^#\/(s|c)\/(.+)$/.exec(window.location.hash);
  if (match === null) {
    return null;
  }
  return { kind: match[1] === "c" ? "chat" : "pty", id: decodeURIComponent(match[2]!) };
}

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<"checking" | "form" | "ready">("checking");
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // null = 会话列表页，非 null = 该会话的终端/聊天页；hash 是事实源
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(sessionFromHash);

  useEffect(() => {
    const sync = (): void => setActiveSession(sessionFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function adoptSession(session: string): void {
    localStorage.setItem(TOKEN_STORAGE_KEY, session);
    setToken(session);
    setPhase("ready");
  }

  useEffect(() => {
    // URL ?token=（随手从 Hub 日志复制粘贴的入口）：立即从地址栏抹掉再换发，
    // 根 token 不留在历史记录也不落 localStorage
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl !== null) {
      url.searchParams.delete("token");
      history.replaceState(null, "", url);
    }
    void (async () => {
      if (fromUrl !== null && fromUrl !== "") {
        const session = await exchangeToken(fromUrl);
        if (session !== null) {
          adoptSession(session);
          return;
        }
        setFormError("token 未通过验证或 Hub 不可达");
        setPhase("form");
        return;
      }
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored === null) {
        setPhase("form");
        return;
      }
      if ((await checkToken(stored)) === "invalid") {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setPhase("form");
        return;
      }
      setToken(stored);
      setPhase("ready");
    })();
  }, []);

  if (phase === "checking") {
    return null;
  }

  if (phase === "form" || token === null) {
    return (
      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft === "") {
            return;
          }
          void exchangeToken(draft).then((session) => {
            if (session === null) {
              setFormError("token 未通过验证或 Hub 不可达");
              return;
            }
            adoptSession(session);
          });
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
        {formError !== null && <p className="token-form-error">{formError}</p>}
        <button type="submit">连接</button>
      </form>
    );
  }

  if (activeSession === null) {
    return (
      <SessionListView
        token={token}
        onOpen={(id, kind) => {
          // 赋值 hash 会入历史栈：手机返回手势一次回列表，hashchange 同步 state
          window.location.hash = `/${kind === "chat" ? "c" : "s"}/${encodeURIComponent(id)}`;
        }}
      />
    );
  }
  const handleBack = (): void => {
    // replaceState 清 hash 不触发 hashchange，手动同步；不用 history.back()：
    // reload 后直接落在终端页时栈里没有列表页可回
    history.replaceState(null, "", window.location.pathname + window.location.search);
    setActiveSession(null);
  };
  if (activeSession.kind === "chat") {
    return <ChatDebugView token={token} sessionId={activeSession.id} onBack={handleBack} />;
  }
  return <TerminalView token={token} sessionId={activeSession.id} onBack={handleBack} />;
}
