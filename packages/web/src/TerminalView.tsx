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

const HUB_WS_URL = "ws://127.0.0.1:7433/ws";

export function TerminalView({ token }: { token: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("连接中…");

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const term = new Terminal({ cursorBlink: true, fontSize: 14 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const ws = new WebSocket(`${HUB_WS_URL}?token=${encodeURIComponent(token)}`);
    let sessionId: string | null = null;

    function sendMessage(message: ClientMessage): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serializeEnvelope(message));
      }
    }

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
        sendResize();
        term.focus();
        return;
      }
      if (sessionId !== null && message.channel === sessionChannel(sessionId)) {
        if (message.type === "output") {
          term.write(base64ToBytes(message.payload.data));
        } else {
          setStatus(`会话已退出（exit ${message.payload.exitCode}），刷新页面重开`);
        }
      }
    };
    ws.onclose = () => {
      setStatus((prev) => (prev.startsWith("会话已退出") ? prev : "连接已关闭（token/Origin 校验不通过或 Hub 未启动）"));
    };

    const dataListener = term.onData((data) => {
      if (sessionId !== null) {
        sendMessage({
          channel: sessionChannel(sessionId),
          type: "input",
          payload: { data: utf8ToBase64(data) },
        });
      }
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
    };
  }, [token]);

  return (
    <div className="app">
      <div className="status-bar">{status}</div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
