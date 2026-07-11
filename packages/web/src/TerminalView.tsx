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
import { HUB_WS_URL } from "./hubUrl.js";

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

export function TerminalView({
  token,
  sessionId,
  onBack,
}: {
  token: string;
  sessionId: string;
  onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [statusLine, setStatusLine] = useState<{ text: string; tone: StatusTone }>({
    text: "连接中…",
    tone: "info",
  });
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

    // 断线自动重连（ADR-0005：连接只是观察者，断开重连即恢复）。
    // disposed = 组件卸载；sessionExited = 会话已退出，二者都不再重连。
    let ws: WebSocket | null = null;
    let disposed = false;
    let sessionExited = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function sendMessage(message: ClientMessage): void {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(serializeEnvelope(message));
      }
    }

    function sendInput(data: string): void {
      sendMessage({
        channel: sessionChannel(sessionId),
        type: "input",
        payload: { data: utf8ToBase64(data) },
      });
    }
    sendInputRef.current = sendInput;

    function sendResize(): void {
      sendMessage({
        channel: CONTROL_CHANNEL,
        type: "resize",
        payload: { sessionId, cols: term.cols, rows: term.rows },
      });
    }

    function scheduleReconnect(): void {
      if (disposed || sessionExited || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      setStatusLine({ text: `连接断开，${Math.round(delay / 1000)} 秒后重连…`, tone: "error" });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed) {
        return;
      }
      setStatusLine({
        text: reconnectAttempt === 0 ? "连接中…" : `重连中…（第 ${reconnectAttempt} 次）`,
        tone: "info",
      });
      const socket = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
      ws = socket;

      socket.onopen = () => {
        sendMessage({ channel: CONTROL_CHANNEL, type: "attach", payload: { sessionId } });
      };
      socket.onmessage = (event) => {
        const message = parseHubMessage(String(event.data));
        if (message === null) {
          return;
        }
        if (message.type === "attached" && message.payload.sessionId === sessionId) {
          // 重连恢复：清掉旧画面再吃 ring buffer 重放，避免内容叠加；
          // 随后服务端 resize 抖动逼全屏 TUI 整屏重绘收敛
          term.reset();
          reconnectAttempt = 0;
          setStatusLine({ text: `已附加会话 ${sessionId}`, tone: "ok" });
          setAttached(true);
          sendResize();
          term.focus();
          return;
        }
        if (message.type === "error") {
          setStatusLine({ text: message.payload.message, tone: "error" });
          setAttached(false);
          return;
        }
        if (message.channel === sessionChannel(sessionId)) {
          if (message.type === "output") {
            term.write(base64ToBytes(message.payload.data));
          } else if (message.type === "exit") {
            sessionExited = true;
            setStatusLine({
              text: `会话已退出（exit ${message.payload.exitCode}），返回列表重开`,
              tone: "error",
            });
            setAttached(false);
          }
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

    // 回前台/网络恢复时不等退避定时器：锁屏期间浏览器节流定时器且退避可能已攀升，
    // 直接清零重连。若 ws 自认 OPEN 但实际已死，onclose 稍后到达，用清零后的退避快速重试
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
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", reconnectNow);
      observer.disconnect();
      dataListener.dispose();
      resizeListener.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      sendInputRef.current = null;
    };
  }, [token, sessionId]);

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
      <div className="status-bar" data-tone={statusLine.tone}>
        <button type="button" className="status-back" onClick={onBack} aria-label="返回会话列表">
          ‹ 列表
        </button>
        <span className="status-dot" aria-hidden="true" />
        {statusLine.text}
      </div>
      <div className="terminal-container" ref={containerRef} />
      <KeyBar ctrl={ctrl} disabled={!attached} onCtrlTap={handleCtrlTap} onKey={handleKey} />
    </div>
  );
}
