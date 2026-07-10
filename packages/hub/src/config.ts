// Hub 配置。监听地址不在配置项里：仅监听 loopback 是 ADR-0003 的定局，写死为常量。

import { homedir } from "node:os";

export const HUB_HOST = "127.0.0.1";

export const DEFAULT_PORT = 7433;

const MIN_TOKEN_LENGTH = 32;

const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export interface HubConfig {
  token: string;
  allowedOrigins: ReadonlySet<string>;
  port: number;
  shell: string;
  /** 新建会话的 cwd 预设列表（前端下拉），手输路径兜底。 */
  cwds: string[];
}

export function loadConfig(env: Record<string, string | undefined>): HubConfig {
  const token = env["ZAGENT_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new Error("ZAGENT_TOKEN 未设置：Hub 拒绝在无 token 的情况下启动");
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`ZAGENT_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符（长随机 token 是不可关闭的底线）`);
  }

  const allowedOrigins = new Set(DEFAULT_DEV_ORIGINS);
  const extra = env["ZAGENT_ALLOWED_ORIGINS"] ?? "";
  for (const raw of extra.split(",")) {
    const origin = raw.trim();
    if (origin === "") {
      continue;
    }
    if (origin.includes("*")) {
      throw new Error(`ZAGENT_ALLOWED_ORIGINS 不接受通配符：${origin}`);
    }
    allowedOrigins.add(origin);
  }

  const port = env["ZAGENT_PORT"] !== undefined ? Number(env["ZAGENT_PORT"]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ZAGENT_PORT 不是合法端口：${env["ZAGENT_PORT"]}`);
  }

  const cwds: string[] = [];
  for (const raw of (env["ZAGENT_CWDS"] ?? "").split(",")) {
    const cwd = raw.trim();
    if (cwd !== "" && !cwds.includes(cwd)) {
      cwds.push(cwd);
    }
  }
  if (cwds.length === 0) {
    cwds.push(homedir());
  }

  return {
    token,
    allowedOrigins,
    port,
    shell: env["ZAGENT_SHELL"] ?? "bash",
    cwds,
  };
}
