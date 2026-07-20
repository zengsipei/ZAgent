// issue #17 一次性验收：chat 会话三条标准的 WS 协议级证据。
// phase1：新建 chat 会话 → 一轮含工具调用的对话 → 结构化消息流 + claudeSessionId 簿记（留会话在跑）
// phase2：全新连接（模拟断线重连）→ 会话仍在 → chat-history 回放 → kill/exit 生命周期与 pty 一致
import { WebSocket } from "ws";

const token = process.env.ZAGENT_TOKEN;
const scratch = process.env.ZAGENT_ACCEPT_CWD;
const phase = process.argv[2];
if (!token || !scratch || !["phase1", "phase2"].includes(phase)) {
  throw new Error("用法：ZAGENT_TOKEN=… ZAGENT_ACCEPT_CWD=… node verify-chat-acceptance.mjs phase1|phase2");
}

const ws = new WebSocket(`ws://127.0.0.1:7433/ws?token=${encodeURIComponent(token)}`, {
  origin: "http://localhost:5173",
});
const send = (channel, type, payload) => ws.send(JSON.stringify({ channel, type, payload }));
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const timer = setTimeout(() => fail("超时"), 180000);

let sessionId = process.env.ZAGENT_ACCEPT_SESSION ?? null;
let lastSessions = [];
const seen = { deltas: 0, items: [], states: [] };
let inputSent = false;
let killSent = 0;

ws.on("error", (e) => fail(e.message));
ws.on("message", (raw) => {
  const env = JSON.parse(String(raw));

  if (env.channel === "control" && env.type === "hello") {
    if (phase === "phase1") {
      const chat = env.payload.templates.find((t) => t.id === "claude-chat");
      if (!chat || chat.kind !== "chat") fail("hello 缺少 kind=chat 的 claude-chat 模板");
      console.log("PASS: hello 下发 claude-chat 模板（kind=chat）");
      send("control", "create", { template: "claude-chat", cwd: scratch, args: [
        "--dangerously-skip-permissions", "--settings", `${scratch}/hook-settings.json`,
      ] });
    } else {
      const s = env.payload.sessions.find((x) => x.id === sessionId);
      if (!s) fail(`重连后会话 ${sessionId} 不在列表`);
      if (s.status !== "running") fail(`重连后会话状态 ${s.status}，应为 running`);
      if (!s.claudeSessionId) fail("重连后 claudeSessionId 丢失");
      console.log(`PASS: 断线后会话仍在（running，claude:${s.claudeSessionId.slice(0, 8)}）`);
      send("control", "attach", { sessionId });
    }
    return;
  }

  if (env.channel === "control" && env.type === "created") {
    sessionId = env.payload.session.id;
    if (env.payload.session.type !== "chat") fail("created 会话 type 不是 chat");
    console.log(`PASS: chat 会话已创建（${sessionId}，command: ${env.payload.session.command}）`);
    send("control", "attach", { sessionId });
    return;
  }

  if (env.channel === "control" && env.type === "attached") {
    if (env.payload.sessionType !== "chat") fail(`attached sessionType=${env.payload.sessionType}`);
    return;
  }

  if (env.channel === "control" && env.type === "sessions") {
    lastSessions = env.payload.sessions;
    if (phase === "phase2" && killSent === 1) {
      const s = lastSessions.find((x) => x.id === sessionId);
      if (s && s.status === "exited") {
        console.log(`PASS: kill 后快照状态 exited（exit ${s.exitCode}）`);
        killSent = 2;
        send("control", "kill", { sessionId }); // 对已退出会话再 kill = 移除记录（与 pty 一致）
      }
    } else if (phase === "phase2" && killSent === 2) {
      if (!lastSessions.some((x) => x.id === sessionId)) {
        console.log("PASS: 再次 kill 移除记录 —— 生命周期与 pty 一致");
        clearTimeout(timer);
        process.exit(0);
      }
    }
    return;
  }

  if (env.channel !== `session:${sessionId}`) return;

  if (env.type === "chat-history") {
    if (phase === "phase1" && !inputSent) {
      if (env.payload.items.length !== 0 || env.payload.state !== "idle") {
        fail("新会话的 chat-history 应为空 + idle");
      }
      console.log("PASS: attach 收到 chat-history（空时间线，state=idle）");
      inputSent = true;
      send(`session:${sessionId}`, "chat-input", {
        text: "请用 Bash 工具执行 echo ZAGENT_CHAT_OK，完成后只回复两个字：完成",
      });
    } else if (phase === "phase2") {
      const kinds = env.payload.items.map((i) => i.kind);
      const need = ["user", "assistant", "tool_use", "tool_result"];
      const missing = need.filter((k) => !kinds.includes(k));
      if (missing.length > 0) fail(`回放缺条目：${missing.join(",")}（实际 ${kinds.join(",")}）`);
      const toolResult = env.payload.items.find((i) => i.kind === "tool_result");
      if (!toolResult.text.includes("ZAGENT_CHAT_OK")) fail("回放的 tool_result 不含标记输出");
      console.log(`PASS: chat-history 回放 ${env.payload.items.length} 条（${kinds.join(" → ")}），state=${env.payload.state}`);
      killSent = 1;
      send("control", "kill", { sessionId });
    }
    return;
  }

  if (phase !== "phase1") {
    if (env.type === "exit") console.log(`（收到 exit 信封，exit ${env.payload.exitCode}）`);
    return;
  }

  if (env.type === "chat-delta") seen.deltas += 1;
  if (env.type === "chat-state") seen.states.push(env.payload.state);
  if (env.type === "chat-item") {
    seen.items.push(env.payload.item);
    console.log(`  chat-item: [${env.payload.item.kind}] ${(env.payload.item.text ?? env.payload.item.name ?? "").slice(0, 60)}`);
  }
  // 回合收口：thinking → … → idle 后做总校验
  if (env.type === "chat-state" && env.payload.state === "idle" && inputSent) {
    const kinds = seen.items.map((i) => i.kind);
    for (const k of ["user", "assistant", "tool_use", "tool_result"]) {
      if (!kinds.includes(k)) fail(`消息流缺 ${k} 条目（实际 ${kinds.join(",")}）`);
    }
    if (!seen.states.includes("thinking")) fail("未观察到 thinking 状态");
    if (seen.deltas === 0) fail("未收到任何 chat-delta 增量");
    const info = lastSessions.find((s) => s.id === sessionId);
    if (!info?.claudeSessionId) fail("sessions 快照未带 claudeSessionId 簿记");
    console.log(`PASS: 结构化消息流完整 —— ${seen.deltas} 个增量，条目序列 ${kinds.join(" → ")}，状态 ${["idle", ...seen.states].join("→")}`);
    console.log(`PASS: claudeSessionId 簿记 = ${info.claudeSessionId}`);
    console.log(`SESSION_ID=${sessionId}`);
    clearTimeout(timer);
    process.exit(0); // 连接关闭即「断线」，会话留给 phase2
  }
});
