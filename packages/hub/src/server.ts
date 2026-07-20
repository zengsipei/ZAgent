// Hub 服务器：WS upgrade 阶段做底线认证；会话管理（list/create/kill/attach）
// 全部走 control 通道信封消息，不新增 REST 端点（ADR-0004）。
// 默认仅监听 127.0.0.1（ADR-0003）；容器部署经 ZAGENT_HOST 绑定容器内网（ADR-0002）。

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

import { AuthFailureLimiter, clientKey, isRootToken, issueSessionToken, verifyToken, verifyUpgrade } from "./auth.js";
import { ChatSession } from "./chatSession.js";
import type { HubConfig } from "./config.js";
import { SessionManager, buildTemplates, type ManagedSession } from "./manager.js";
import { PtySession } from "./session.js";
import { serveStatic } from "./static.js";

export interface RunningHub {
  port: number;
  address: string;
  close(): Promise<void>;
}

/** 某连接对某会话上报的最大显示容量（#9）。 */
interface ClientCapacity {
  cols: number;
  rows: number;
}

// 单连接发送缓冲上限：断网不发 close 帧的死连接会一直堆积输出直到 TCP 超时，
// 超限直接掐断（触发 close 清理），护住 ring buffer 之外的内存路径。
// 阈值须明显大于单帧重放（ring buffer 上限的 base64 最大 ≈ 4MB），避免误杀慢速活跃端
const MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024;

export async function startHub(config: HubConfig): Promise<RunningHub> {
  const limiter = new AuthFailureLimiter();
  const server = http.createServer((req, res) => {
    if (handleAuthRequest(req, res)) {
      return;
    }
    if (config.staticDir === null) {
      res.writeHead(404).end();
      return;
    }
    serveStatic(config.staticDir, req, res);
  });

  // 认证端点（ADR-0007）：POST /auth/session 用根 token 换发会话 token；
  // GET /auth/check 校验持有的 token 是否仍有效（前端启动时的登出判定）。
  // 返回 true 表示该请求已被处理（含被限速拒绝）。
  function handleAuthRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/auth/session" && pathname !== "/auth/check") {
      return false;
    }
    const ip = clientKey(req);
    if (limiter.isBlocked(ip)) {
      res.writeHead(429).end();
      return true;
    }

    if (pathname === "/auth/check") {
      // 同源 GET fetch 不带 Origin 头，这里只验 token；无副作用，限速兜住枚举
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
      if (token === null || !verifyToken(token, config.token)) {
        limiter.recordFailure(ip);
        res.writeHead(401).end();
        return true;
      }
      res.writeHead(204).end();
      return true;
    }

    // POST /auth/session：浏览器对 POST 一定带 Origin，同源也强制校验（CSRF 防线）
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return true;
    }
    const origin = req.headers.origin;
    if (origin === undefined || !config.allowedOrigins.has(origin)) {
      limiter.recordFailure(ip);
      res.writeHead(403).end();
      return true;
    }
    let body = "";
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 4096) {
        overflow = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) {
        return;
      }
      let provided: unknown;
      try {
        provided = (JSON.parse(body) as Record<string, unknown>)["token"];
      } catch {
        provided = undefined;
      }
      // 只有根 token 能签发：会话 token 不能续签自己，到期必须回根凭证
      if (typeof provided !== "string" || !isRootToken(provided, config.token)) {
        limiter.recordFailure(ip);
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(issueSessionToken(config.token)));
    });
    return true;
  }
  const wss = new WebSocketServer({ noServer: true });
  const templates = buildTemplates(config.shell);
  const manager = new SessionManager(templates);
  // 每个连接各自 attach 的会话 → 该端上报的最大容量（null = 已附加但尚未上报）。
  // 输出只发给附加者；会话有效尺寸 = 全部已上报容量的最小交集（#9，tmux 式）
  const attachments = new Map<WebSocket, Map<string, ClientCapacity | null>>();

  function send(ws: WebSocket, message: HubMessage): void {
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      ws.terminate();
      return;
    }
    ws.send(serializeEnvelope(message));
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

  // 重算会话有效尺寸 = 全部已上报容量的逐维 min；变化才真正 resize 并广播 resized。
  // 无人上报容量时保持现状（attach / detach / 断开 / 容量变化都从这里走）
  function applyMinSize(sessionId: string): void {
    const managed = manager.get(sessionId);
    if (managed === undefined || !(managed.session instanceof PtySession) || managed.session.exited) {
      return;
    }
    let cols = Infinity;
    let rows = Infinity;
    for (const attached of attachments.values()) {
      const capacity = attached.get(sessionId);
      if (capacity != null) {
        cols = Math.min(cols, capacity.cols);
        rows = Math.min(rows, capacity.rows);
      }
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return;
    }
    const current = managed.session.size;
    if (cols === current.cols && rows === current.rows) {
      return;
    }
    managed.session.resize(cols, rows);
    sendToAttached(sessionId, {
      channel: sessionChannel(sessionId),
      type: "resized",
      payload: { cols, rows },
    });
  }

  // 会话创建时挂一次转发：pty 转字节流，chat 转结构化消息；退出后广播快照（共通）
  function wireSession(managed: ManagedSession): void {
    const { session } = managed;
    if (session instanceof ChatSession) {
      const channel = sessionChannel(session.id);
      session.onItem((item) => {
        sendToAttached(session.id, { channel, type: "chat-item", payload: { item } });
      });
      session.onDelta((text) => {
        sendToAttached(session.id, { channel, type: "chat-delta", payload: { text } });
      });
      session.onState((state) => {
        sendToAttached(session.id, { channel, type: "chat-state", payload: { state } });
      });
      // claudeSessionId 已由 manager 写进元数据，这里把快照播出去（列表可见、#19 可取）
      session.onSessionId(() => broadcastSessions());
    } else {
      session.onData((data) => {
        sendToAttached(session.id, {
          channel: sessionChannel(session.id),
          type: "output",
          payload: { data: utf8ToBase64(data) },
        });
      });
    }
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
    const ip = clientKey(req);
    if (limiter.isBlocked(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const verdict = verifyUpgrade(req, config);
    if (!verdict.ok) {
      limiter.recordFailure(ip);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    attachments.set(ws, new Map());
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
          if (
            managed !== undefined &&
            managed.session instanceof PtySession &&
            !managed.session.exited
          ) {
            managed.session.write(base64ToUtf8(message.payload.data));
          }
          return;
        }

        if (message.type === "chat-input") {
          const managed = manager.get(sessionIdOf(message.channel));
          if (
            managed !== undefined &&
            managed.session instanceof ChatSession &&
            !managed.session.exited
          ) {
            // user 回显与 thinking 状态经 wireSession 的回调广播给所有附加端
            managed.session.sendUserText(message.payload.text);
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
            // 重复 attach（重连补发）幂等：不覆盖已上报的容量
            if (!attached.has(managed.session.id)) {
              attached.set(managed.session.id, null);
            }
            if (managed.session instanceof ChatSession) {
              send(ws, {
                channel: CONTROL_CHANNEL,
                type: "attached",
                // chat 会话无网格概念，尺寸给占位值（信封字段统一，消费端忽略）
                payload: { sessionId: managed.session.id, sessionType: "chat", cols: 80, rows: 24 },
              });
              // 时间线重放（ADR-0005 的 chat 对应物）：定稿条目 + 状态 + 回合中增量
              send(ws, {
                channel: sessionChannel(managed.session.id),
                type: "chat-history",
                payload: managed.session.history(),
              });
              if (managed.session.exited) {
                send(ws, {
                  channel: sessionChannel(managed.session.id),
                  type: "exit",
                  payload: { exitCode: managed.info.exitCode ?? 0 },
                });
              }
              return;
            }
            const size = managed.session.size;
            send(ws, {
              channel: CONTROL_CHANNEL,
              type: "attached",
              payload: {
                sessionId: managed.session.id,
                sessionType: managed.session.type,
                cols: size.cols,
                rows: size.rows,
              },
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
            if (managed.session.exited) {
              // 断线期间会话已死：exit 只发给了当时在场的连接，这里补发，
              // 否则重连端显示「已附加」却输入无响应
              send(ws, {
                channel: sessionChannel(managed.session.id),
                type: "exit",
                payload: { exitCode: managed.info.exitCode ?? 0 },
              });
            } else {
              // 重放后抖动一次，逼全屏 TUI 整屏重绘收敛画面
              managed.session.scheduleNudge();
            }
            return;
          }
          case "detach": {
            attached.delete(message.payload.sessionId);
            applyMinSize(message.payload.sessionId);
            return;
          }
          case "resize": {
            // 容量上报（#9）：只有已附加的端参与尺寸协商
            const { sessionId, cols, rows } = message.payload;
            if (attached.has(sessionId)) {
              attached.set(sessionId, { cols, rows });
              applyMinSize(sessionId);
            }
            return;
          }
        }
      } catch (err) {
        console.error("[hub] dropped malformed message:", err);
      }
    });

    ws.on("close", () => {
      const attached = attachments.get(ws);
      attachments.delete(ws);
      if (attached !== undefined) {
        // 小屏离开后剩余端的 min 变大，PTY 自动恢复满幅
        for (const sessionId of attached.keys()) {
          applyMinSize(sessionId);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
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
