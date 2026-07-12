// Hub 入口：加载仓库根 .env（不覆盖已有环境变量）→ 校验配置 → 启动。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { startHub } from "./server.js";

loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), "../../../.env"));

const config = loadConfig(process.env);
const hub = await startHub(config);
console.log(`[hub] listening on ws://${hub.address}:${hub.port}/ws`);
console.log(`[hub] allowed origins: ${[...config.allowedOrigins].join(", ")}`);

function loadDotEnv(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null && process.env[match[1]!] === undefined && match[2] !== "") {
      process.env[match[1]!] = match[2]!;
    }
  }
}
