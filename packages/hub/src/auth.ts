// 应用层底线认证（ADR-0003）：WS upgrade 阶段校验长随机 token + Origin 白名单。
// 这两项校验没有开关——「可配置关闭」本身就是被否决的选项。

import { createHash, timingSafeEqual } from "node:crypto";

import type { HubConfig } from "./config.js";

interface UpgradeRequestLike {
  url?: string | undefined;
  headers: { origin?: string | undefined };
}

export type UpgradeVerdict = { ok: true } | { ok: false; reason: string };

export function verifyUpgrade(req: UpgradeRequestLike, config: HubConfig): UpgradeVerdict {
  const origin = req.headers.origin;
  if (origin === undefined || !config.allowedOrigins.has(origin)) {
    return { ok: false, reason: "origin not allowed" };
  }

  if (req.url === undefined) {
    return { ok: false, reason: "missing url" };
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    return { ok: false, reason: "unknown path" };
  }
  const token = url.searchParams.get("token");
  if (token === null || !tokensMatch(token, config.token)) {
    return { ok: false, reason: "invalid token" };
  }

  return { ok: true };
}

// 比较 sha256 摘要而非原文，规避 timingSafeEqual 的等长前提泄露 token 长度。
function tokensMatch(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
