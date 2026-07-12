// 应用层认证（ADR-0007，替代 ADR-0003 的底线条款）：公网直连后没有边缘认证在前，
// 这层是唯一防线——长随机根 token + Origin 白名单 + 会话 token 签发 + 失败限速。
// token 与 Origin 校验没有开关——「可配置关闭」本身就是被否决的选项。

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
  if (token === null || !verifyToken(token, config.token)) {
    return { ok: false, reason: "invalid token" };
  }

  return { ok: true };
}

/** 根 token 或有效会话 token 均可通过（根 token 保留给测试/curl 调试直连）。 */
export function verifyToken(provided: string, rootToken: string): boolean {
  return isRootToken(provided, rootToken) || isValidSessionToken(provided, rootToken);
}

export function isRootToken(provided: string, rootToken: string): boolean {
  return tokensMatch(provided, rootToken);
}

// ---------------------------------------------------------------------------
// 会话 token：`v1.<expiresAtMs>.<nonce>.<hmac>`，HMAC-SHA256 以根 token 为密钥。
// 无状态——校验只需重算 MAC，不做簿记；吊销 = 换根 token。
// 签发只认根 token：会话 token 不能续签自己，到期必须回根凭证。
// ---------------------------------------------------------------------------

const SESSION_TOKEN_VERSION = "v1";

/** 默认有效期 30 天：手机日用不必频繁粘根 token，泄露面又有界。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function issueSessionToken(
  rootToken: string,
  ttlMs = SESSION_TTL_MS,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const nonce = randomBytes(16).toString("base64url");
  const body = `${SESSION_TOKEN_VERSION}.${expiresAt}.${nonce}`;
  const mac = createHmac("sha256", rootToken).update(body).digest("base64url");
  return { token: `${body}.${mac}`, expiresAt };
}

export function isValidSessionToken(token: string, rootToken: string, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_TOKEN_VERSION) {
    return false;
  }
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return false;
  }
  const body = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expectedMac = createHmac("sha256", rootToken).update(body).digest("base64url");
  return tokensMatch(parts[3]!, expectedMac);
}

// ---------------------------------------------------------------------------
// 失败限速：按来源 IP 的固定窗口计数，打满后该 IP 的认证请求一律拒绝到窗口结束。
// 内存态即可——重启清零无妨，防的是无人值守时的暴力枚举。
// 经中继（frp/VPS）接入时所有来源同 IP，限速退化为全局阈值，作为兜底仍成立。
// ---------------------------------------------------------------------------

export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_AUTH_FAILURES_PER_WINDOW = 10;

export class AuthFailureLimiter {
  private readonly failures = new Map<string, { count: number; windowStart: number }>();

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (entry === undefined) {
      return false;
    }
    if (now - entry.windowStart >= AUTH_FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= MAX_AUTH_FAILURES_PER_WINDOW;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (entry === undefined || now - entry.windowStart >= AUTH_FAILURE_WINDOW_MS) {
      // 大量陌生来源撑爆内存前先清一轮过期窗口
      if (this.failures.size >= 10_000) {
        for (const [key, value] of this.failures) {
          if (now - value.windowStart >= AUTH_FAILURE_WINDOW_MS) {
            this.failures.delete(key);
          }
        }
      }
      this.failures.set(key, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }
}

// 比较 sha256 摘要而非原文，规避 timingSafeEqual 的等长前提泄露 token 长度。
function tokensMatch(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
