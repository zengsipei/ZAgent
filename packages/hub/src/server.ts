// Hub 服务器：WS upgrade 阶段做底线认证；会话管理（list/create/kill/attach）
// 全部走 control 通道信封消息，不新增 REST 端点（ADR-0004）。
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
  sessionIdOf,
  utf8ToBase64,
  type HubMessage,
} from "@zagent/protocol";

import { verifyUpgrade } from "./auth.js";
import { HUB_HOST, type HubConfig } from "./config.js";
import { SessionManager, buildTemplates, type ManagedSession } from "./manager.js";

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
  const templates = buildTemplates(config.shell);
  const manager = new SessionManager(templates);
  // 每个连接各自 attach 的会话集合：输出只发给附加者，会话快照广播给所有连接
  const attachments = new Map<WebSocket, Set<string>>();

  function send(ws: WebSocket, message: HubMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(serializeEnvelope(message));
    }
  }

  function broadcastSessions(): void {
    const message: HubMessage = {
      channel: CONTROL_CHANNEL,
      type: "sessions",
      payload: { sessions: manager.list() },
    };
    for (const ws of attachments.keys()) {
      send(ws, message);
    }
  }

  function sendToAttached(sessionId: string, message: HubMessage): void {
    for (const [ws, attached] of attachments) {
      if (attached.has(sessionId)) {
        send(ws, message);
      }
    }
  }

  function sendError(ws: WebSocket, message: string): void {
    send(ws, { channel: CONTROL_CHANNEL, type: "error", payload: { message } });
  }

  // 会话创建时挂一次输出/退出转发：输出发给当时 attach 的连接，退出后广播快照
  function wireSession(managed: ManagedSession): void {
    const { session } = managed;
    session.onData((data) => {
      sendToAttached(session.id, {
        channel: sessionChannel(session.id),
        type: "output",
        payload: { data: utf8ToBase64(data) },
      });
    });
    session.onExit((exitCode) => {
      sendToAttached(session.id, {
        channel: sessionChannel(session.id),
        type: "exit",
        payload: { exitCode },
      });
      broadcastSessions();
    });
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
    attachments.set(ws, new Set());
    send(ws, {
      channel: CONTROL_CHANNEL,
      type: "hello",
      payload: { templates, cwds: config.cwds, sessions: manager.list() },
    });

    ws.on("message", (raw) => {
      // 单条坏消息（含合法信封 + 非法 base64 / 未知模板 / spawn 失败）只回 error 或丢弃，不能带崩 Hub
      try {
        const message = parseClientMessage(String(raw));
        if (message === null) {
          return;
        }
        const attached = attachments.get(ws)!;

        if (message.type === "input") {
          const managed = manager.get(sessionIdOf(message.channel));
          if (managed !== undefined && !managed.session.exited) {
            managed.session.write(base64ToUtf8(message.payload.data));
          }
          return;
        }

        switch (message.type) {
          case "list": {
            send(ws, {
              channel: CONTROL_CHANNEL,
              type: "sessions",
              payload: { sessions: manager.list() },
            });
            return;
          }
          case "create": {
            let managed: ManagedSession;
            try {
              managed = manager.create(message.payload);
            } catch (err) {
              sendError(ws, err instanceof Error ? err.message : "创建会话失败");
              return;
            }
            wireSession(managed);
            send(ws, { channel: CONTROL_CHANNEL, type: "created", payload: { session: managed.info } });
            broadcastSessions();
            return;
          }
          case "kill": {
            if (!manager.kill(message.payload.sessionId)) {
              sendError(ws, `会话不存在：${message.payload.sessionId}`);
              return;
            }
            // 运行中会话的退出经由 onExit 广播；已退出会话被移除，这里直接广播快照
            broadcastSessions();
            return;
          }
          case "attach": {
            const managed = manager.get(message.payload.sessionId);
            if (managed === undefined) {
              sendError(ws, `会话不存在：${message.payload.sessionId}`);
              return;
            }
            attached.add(managed.session.id);
            send(ws, {
              channel: CONTROL_CHANNEL,
              type: "attached",
              payload: { sessionId: managed.session.id, sessionType: managed.session.type },
            });
            // ring buffer 重放（ADR-0005）：attach 后先补最近输出
            const replay = managed.session.replayData();
            if (replay !== "") {
              send(ws, {
                channel: sessionChannel(managed.session.id),
                type: "output",
                payload: { data: utf8ToBase64(replay) },
              });
            }
            return;
          }
          case "detach": {
            attached.delete(message.payload.sessionId);
            return;
          }
          case "resize": {
            const managed = manager.get(message.payload.sessionId);
            if (managed !== undefined && !managed.session.exited) {
              managed.session.resize(message.payload.cols, message.payload.rows);
            }
            return;
          }
        }
      } catch (err) {
        console.error("[hub] dropped malformed message:", err);
      }
    });

    ws.on("close", () => {
      attachments.delete(ws);
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
      manager.killAll();
      for (const ws of attachments.keys()) {
        ws.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
