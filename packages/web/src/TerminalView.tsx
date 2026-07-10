import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import {
  CONTROL_CHANNEL,
  base64ToBytes,
  parseHubMessage,
  serializeEnvelope,
  sessionChannel,
  utf8ToBase64,
  type ClientMessage,
} from "@zagent/protocol";

import { KeyBar, composeCtrl, keySequence, type CtrlState, type KeyId } from "./KeyBar.js";

// WS 走同源 /ws：开发时由 vite 代理到环回 Hub，生产走隧道同样是同源形态
const HUB_WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

const TERMINAL_FONT =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace';

// xterm 的 theme 只认 CSS 颜色字符串，这里是 styles.css 里 OKLCH token 的 sRGB 近似
const TERMINAL_THEME = {
  background: "#0d1517",
  foreground: "#e4ebeb",
  cursor: "#4fd0c4",
  cursorAccent: "#0d1517",
  selectionBackground: "#4fd0c455",
};

type StatusTone = "info" | "ok" | "error";

export function TerminalView({ token }: { token: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("连接中…");
  const [tone, setTone] = useState<StatusTone>("info");
  const [attached, setAttached] = useState(false);
  const [ctrl, setCtrl] = useState<CtrlState>("off");
  const ctrlRef = useRef<CtrlState>("off");
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<((data: string) => void) | null>(null);

  function updateCtrl(next: CtrlState): void {
    ctrlRef.current = next;
    setCtrl(next);
  }

  // 系统键盘弹起时 visualViewport 变矮：让 .app 跟着收缩，键条始终贴在键盘上方
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return;
    }
    const update = (): void => {
      document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
      // iOS 聚焦输入框时会把页面往上顶，钉回去
      if (viewport.offsetTop > 0) {
        window.scrollTo(0, 0);
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: TERMINAL_FONT,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    const ws = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
    let sessionId: string | null = null;

    function sendMessage(message: ClientMessage): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serializeEnvelope(message));
      }
    }

    function sendInput(data: string): void {
      if (sessionId !== null) {
        sendMessage({
          channel: sessionChannel(sessionId),
          type: "input",
          payload: { data: utf8ToBase64(data) },
        });
      }
    }
    sendInputRef.current = sendInput;

    function sendResize(): void {
      if (sessionId !== null) {
        sendMessage({
          channel: CONTROL_CHANNEL,
          type: "resize",
          payload: { sessionId, cols: term.cols, rows: term.rows },
        });
      }
    }

    ws.onmessage = (event) => {
      const message = parseHubMessage(String(event.data));
      if (message === null) {
        return;
      }
      if (message.type === "attached") {
        sessionId = message.payload.sessionId;
        setStatus(`已附加会话 ${sessionId}`);
        setTone("ok");
        setAttached(true);
        sendResize();
        term.focus();
        return;
      }
      if (sessionId !== null && message.channel === sessionChannel(sessionId)) {
        if (message.type === "output") {
          term.write(base64ToBytes(message.payload.data));
        } else {
          setStatus(`会话已退出（exit ${message.payload.exitCode}），刷新页面重开`);
          setTone("error");
          setAttached(false);
        }
      }
    };
    ws.onclose = () => {
      setAttached(false);
      setStatus((prev) => {
        if (prev.startsWith("会话已退出")) {
          return prev;
        }
        setTone("error");
        return "连接已关闭（token/Origin 校验不通过或 Hub 未启动）";
      });
    };

    const dataListener = term.onData((data) => {
      let out = data;
      // Ctrl 粘滞时把系统键盘敲进来的字符合成为控制字节
      if (ctrlRef.current !== "off") {
        const composed = composeCtrl(data);
        if (composed !== null) {
          out = composed;
          if (ctrlRef.current === "once") {
            ctrlRef.current = "off";
            setCtrl("off");
          }
        }
      }
      sendInput(out);
    });
    const resizeListener = term.onResize(() => sendResize());
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataListener.dispose();
      resizeListener.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      sendInputRef.current = null;
    };
  }, [token]);

  function handleKey(id: KeyId): void {
    const send = sendInputRef.current;
    if (send === null) {
      return;
    }
    const seq = keySequence(id, {
      ctrl: ctrlRef.current !== "off",
      applicationCursor: termRef.current?.modes.applicationCursorKeysMode ?? false,
    });
    if (ctrlRef.current === "once") {
      updateCtrl("off");
    }
    send(seq);
  }

  function handleCtrlTap(): void {
    updateCtrl(ctrl === "off" ? "once" : ctrl === "once" ? "lock" : "off");
  }

  return (
    <div className="app">
      <div className="status-bar" data-tone={tone}>
        <span className="status-dot" aria-hidden="true" />
        {status}
      </div>
      <div className="terminal-container" ref={containerRef} />
      <KeyBar ctrl={ctrl} disabled={!attached} onCtrlTap={handleCtrlTap} onKey={handleKey} />
    </div>
  );
}
