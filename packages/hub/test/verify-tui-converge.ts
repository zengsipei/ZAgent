// 一次性人工验收脚本（issue #4 验收 2）：全屏 TUI（vim）断线重连后画面收敛。
// 跑法：npx tsx test/verify-tui-converge.ts   （不进测试套件：依赖本机 vim）

import { WebSocket } from "ws";

import { CONTROL_CHANNEL, base64ToUtf8, parseEnvelope, serializeEnvelope, utf8ToBase64 } from "@zagent/protocol";

import { loadConfig } from "../src/config.js";
import { startHub } from "../src/server.js";

const TOKEN = "t".repeat(64);
const ORIGIN = "http://localhost:5173";

const hub = await startHub(loadConfig({ ZAGENT_TOKEN: TOKEN, ZAGENT_PORT: "0" }));
const url = `ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`;

function connect(): Promise<{ ws: WebSocket; output: () => string; reset: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: ORIGIN });
    let buf = "";
    ws.on("message", (raw) => {
      const env = parseEnvelope(String(raw));
      if (env !== null && env.type === "output") {
        buf += base64ToUtf8((env.payload as { data: string }).data);
      }
    });
    ws.once("open", () => resolve({ ws, output: () => buf, reset: () => (buf = "") }));
    ws.once("error", reject);
  });
}

function send(ws: WebSocket, channel: string, type: string, payload: unknown): void {
  ws.send(serializeEnvelope({ channel, type, payload }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. 创建会话，进入 vim（全屏 TUI，进 alternate screen）
const a = await connect();
send(a.ws, CONTROL_CHANNEL, "create", { template: "bash", cwd: process.cwd() });
await sleep(2500);
send(a.ws, CONTROL_CHANNEL, "attach", { sessionId: "s1" });
send(a.ws, CONTROL_CHANNEL, "resize", { sessionId: "s1", cols: 100, rows: 30 });
await sleep(1000);
send(a.ws, "session:s1", "input", { data: utf8ToBase64("vim\r") });
await sleep(3000);
// vim 状态栏 [No Name] 做指纹：MSYS vim 不进 alternate screen，检测不到 1049 序列
const sawVim = a.output().includes("[No Name]");
console.log("[1] vim 全屏已启动:", sawVim);

// 2. 模拟断网（不发 close 帧），等待期间会话无人观察
a.ws.terminate();
await sleep(2000);

// 3. 重连 attach：重放恢复 + 延迟抖动逼 vim 整屏重绘。
// 模拟真实前端：attach 后立即回报相同尺寸（不得打断排期中的抖动）
const b = await connect();
send(b.ws, CONTROL_CHANNEL, "attach", { sessionId: "s1" });
send(b.ws, CONTROL_CHANNEL, "resize", { sessionId: "s1", cols: 100, rows: 30 });
await sleep(150); // < NUDGE_AFTER_ATTACH_DELAY_MS：重放已到、抖动还没 fire
const replay = b.output();
const replayHasVim = replay.includes("[No Name]");
console.log("[2] 重放含 vim 画面:", replayHasVim);

// 4. 抖动在 attach 后 250ms fire、300ms 恢复：vim 收到 WINCH 重发整屏
b.reset();
await sleep(1500);
const redraw = b.output();
const redrewFull = redraw.includes("[No Name]") || redraw.includes("\x1b[H") || redraw.includes("\x1b[2J");
console.log("[3] 抖动后 vim 整屏重绘（收到新的全屏序列，字节数", redraw.length, "）:", redrewFull);

send(b.ws, "session:s1", "input", { data: utf8ToBase64(":q!\r") });
await sleep(800);
b.ws.close();

const ok = sawVim && replayHasVim && redrewFull;
console.log(ok ? "\n验收 2 证据齐全 ✔" : "\n验收 2 未通过 ✘");
// 不等 hub.close()：node-pty 在 Windows kill 子进程时有已知的 AttachConsole 噪音 crash
process.exit(ok ? 0 : 1);
