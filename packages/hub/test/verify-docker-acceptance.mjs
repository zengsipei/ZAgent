// issue #5 一次性验收：容器内 Hub 经 WS 完成 hello 模板检查 + bash 会话工具链检查。
import { WebSocket } from "ws";

const token = process.env.ZAGENT_TOKEN;
if (!token) throw new Error("需要 ZAGENT_TOKEN");
const ws = new WebSocket(`ws://127.0.0.1:7433/ws?token=${token}`, { origin: "http://localhost:7433" });
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const un64 = (s) => Buffer.from(s, "base64").toString("utf8");

let sessionId = null;
let output = "";
const timer = setTimeout(() => { console.error("FAIL: 超时"); process.exit(1); }, 30000);

ws.on("open", () => {});
ws.on("error", (e) => { console.error("FAIL:", e.message); process.exit(1); });
ws.on("message", (raw) => {
  const env = JSON.parse(String(raw));
  if (env.channel === "control" && env.type === "hello") {
    const ids = env.payload.templates.map((t) => t.id);
    console.log("templates:", ids.join(","));
    if (!ids.includes("claude-continue") || !ids.includes("claude-resume")) {
      console.error("FAIL: 缺少复活模板"); process.exit(1);
    }
    ws.send(JSON.stringify({ channel: "control", type: "create", payload: { template: "bash", cwd: "/workspace" } }));
  }
  if (env.channel === "control" && env.type === "created") {
    sessionId = env.payload.session.id;
    ws.send(JSON.stringify({ channel: "control", type: "attach", payload: { sessionId } }));
    setTimeout(() => {
      ws.send(JSON.stringify({ channel: `session:${sessionId}`, type: "input",
        payload: { data: b64("git --version && gh --version | head -1 && node --version && claude --version && codex --version && echo TOOLCHAIN_\"OK\"\r") } }));
    }, 1000);
  }
  if (sessionId && env.channel === `session:${sessionId}` && env.type === "output") {
    output += un64(env.payload.data);
    if (output.includes("TOOLCHAIN_OK")) {
      const lines = output.split(/\r?\n/).filter((l) => /version|^v\d|TOOLCHAIN_OK|Claude Code|codex/i.test(l));
      console.log(lines.join("\n"));
      console.log("PASS: hello 模板 + 容器内 bash 会话 + 工具链齐备");
      clearTimeout(timer);
      ws.send(JSON.stringify({ channel: "control", type: "kill", payload: { sessionId } }));
      setTimeout(() => process.exit(0), 500);
    }
  }
});
