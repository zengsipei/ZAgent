// #18 验收反馈诊断:实证 chat-delta 流式链路。
// 创建 chat 会话 → 发一条纯文本请求(无工具)→ 统计 delta 帧数量与时间分布。
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const token = /^ZAGENT_TOKEN=(.+)$/m.exec(env)[1].trim();

const ws = new WebSocket(`ws://127.0.0.1:7433/ws?token=${encodeURIComponent(token)}`, {
  headers: { origin: "http://127.0.0.1:7433" },
});

let sessionId = null;
let t0 = 0;
let deltaCount = 0;
let deltaChars = 0;
let firstDeltaAt = null;
let lastDeltaAt = null;
const itemLog = [];

function send(obj) {
  ws.send(JSON.stringify(obj));
}

ws.on("open", () => {
  send({ channel: "control", type: "create", payload: { template: "claude-chat", cwd: "F:/zsp/Learn/ZAgent/.orca/tmp" } });
});

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.channel === "control" && m.type === "created") {
    sessionId = m.payload.session.id;
    send({ channel: "control", type: "attach", payload: { sessionId } });
    return;
  }
  if (m.channel === "control" && m.type === "attached") {
    t0 = Date.now();
    console.log("[diag] attached, sending prompt...");
    send({
      channel: `session:${sessionId}`,
      type: "chat-input",
      payload: { text: "Write a 150-word English story about a lighthouse. Plain prose, no tools, no markdown." },
    });
    return;
  }
  if (m.channel !== `session:${sessionId}`) return;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (m.type === "chat-delta") {
    deltaCount++;
    deltaChars += m.payload.text.length;
    if (firstDeltaAt === null) firstDeltaAt = dt;
    lastDeltaAt = dt;
  } else if (m.type === "chat-item") {
    itemLog.push(`${dt}s item:${m.payload.item.kind} len=${(m.payload.item.text ?? m.payload.item.input ?? "").length}`);
  } else if (m.type === "chat-state") {
    itemLog.push(`${dt}s state:${m.payload.state}`);
    if (m.payload.state === "idle") {
      console.log("[diag] turn done");
      console.log(`deltas: ${deltaCount} frames, ${deltaChars} chars, first@${firstDeltaAt}s last@${lastDeltaAt}s`);
      console.log(itemLog.join("\n"));
      send({ channel: "control", type: "kill", payload: { sessionId } });
      setTimeout(() => process.exit(0), 500);
    }
  }
});

setTimeout(() => {
  console.log("[diag] TIMEOUT 120s");
  console.log(`deltas: ${deltaCount} frames, ${deltaChars} chars, first@${firstDeltaAt}s last@${lastDeltaAt}s`);
  console.log(itemLog.join("\n"));
  if (sessionId) send({ channel: "control", type: "kill", payload: { sessionId } });
  setTimeout(() => process.exit(1), 500);
}, 120000);
