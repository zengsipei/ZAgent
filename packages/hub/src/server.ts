// Hub 服务器：WS upgrade 阶段做底线认证，连接即 attach 到硬编码会话 main。
// 仅监听 127.0.0.1（HUB_HOST 常量，见 ADR-0003 隧道无关设计）。

import http from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import {
  CONTROL_CHANNEL,
  base64ToUtf8,
  parseClientMessage,
  serializeEnvelope,
  sessionChannel,
  utf8ToBase64,
  type HubMessage,
} from "@zagent/protocol";

import { verifyUpgrade } from "./auth.js";
import { HUB_HOST, type HubConfig } from "./config.js";
import { PtySession } from "./session.js";

const SESSION_ID = "main";

export interface RunningHub {
  port: number;
  address: string;
  close(): Promise<void>;
}

export async function startHub(config: HubConfig): Promise<RunningHub> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let session: PtySession | null = null;

  function broadcast(message: HubMessage): void {
    const raw = serializeEnvelope(message);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(raw);
      }
    }
  }

  // 会话退出后不复用：下一个连接触发重新 spawn，手动测试里输 exit 不会把 Hub 用死。
  function ensureSession(): PtySession {
    if (session === null || session.exited) {
      const created = new PtySession({
        id: SESSION_ID,
        shell: config.shell,
        cwd: process.cwd(),
      });
      created.onData((data) => {
        broadcast({
          channel: sessionChannel(SESSION_ID),
          type: "output",
          payload: { data: utf8ToBase64(data) },
        });
      });
      created.onExit((exitCode) => {
        broadcast({
          channel: sessionChannel(SESSION_ID),
          type: "exit",
          payload: { exitCode },
        });
      });
      session = created;
    }
    return session;
  }

  server.on("upgrade", (req, socket, head) => {
    const verdict = verifyUpgrade(req, config);
    if (!verdict.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    try {
      clients.add(ws);
      const attached = ensureSession();
      ws.send(
        serializeEnvelope({
          channel: CONTROL_CHANNEL,
          type: "attached",
          payload: { sessionId: attached.id, sessionType: attached.type },
        } satisfies HubMessage),
      );
    } catch (err) {
      console.error("[hub] connection handler failed:", err);
      ws.close();
      return;
    }

    ws.on("message", (raw) => {
      // 单条坏消息（含合法信封 + 非法 base64）只作丢弃，不能带崩 Hub
      try {
        const message = parseClientMessage(String(raw));
        if (message === null || session === null || session.exited) {
          return;
        }
        if (message.type === "input") {
          if (message.channel === sessionChannel(SESSION_ID)) {
            session.write(base64ToUtf8(message.payload.data));
          }
        } else if (message.payload.sessionId === SESSION_ID) {
          session.resize(message.payload.cols, message.payload.rows);
        }
      } catch (err) {
        console.error("[hub] dropped malformed message:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, HUB_HOST, resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    address: address.address,
    close: async () => {
      session?.kill();
      for (const client of clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
