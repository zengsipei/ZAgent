// Issue #6 验收（应用层完整认证）：根 token 换发会话 token、会话 token 可上 WS、
// 认证失败按来源 IP 限速。公网直连后没有边缘认证在前，这层是唯一防线。

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issueSessionToken, isValidSessionToken } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { startHub, type RunningHub } from "../src/server.js";
import { ORIGIN, TOKEN, tryConnect } from "./helpers.js";

describe("会话 token（无状态 HMAC 签发/校验）", () => {
  it("签发的 token 在有效期内校验通过，过期即失效", () => {
    const { token, expiresAt } = issueSessionToken(TOKEN, 1000, 50_000);
    expect(expiresAt).toBe(51_000);
    expect(isValidSessionToken(token, TOKEN, 50_500)).toBe(true);
    expect(isValidSessionToken(token, TOKEN, 51_000)).toBe(false);
  });

  it("篡改任一段（过期时间 / MAC）都失效；换根 token 全部失效", () => {
    const { token } = issueSessionToken(TOKEN, 60_000, 50_000);
    const parts = token.split(".");
    const tampered = [parts[0], "99999999999999", parts[2], parts[3]].join(".");
    expect(isValidSessionToken(tampered, TOKEN, 50_500)).toBe(false);
    expect(isValidSessionToken(token + "x", TOKEN, 50_500)).toBe(false);
    expect(isValidSessionToken(token, "z".repeat(64), 50_500)).toBe(false);
    expect(isValidSessionToken("garbage", TOKEN, 50_500)).toBe(false);
  });
});

describe("认证 HTTP 端点", () => {
  let hub: RunningHub;

  beforeAll(async () => {
    hub = await startHub(loadConfig({ ZAGENT_TOKEN: TOKEN, ZAGENT_PORT: "0" }));
  });

  afterAll(async () => {
    await hub.close();
  });

  function base(): string {
    return `http://127.0.0.1:${hub.port}`;
  }

  it("POST /auth/session：根 token 换发会话 token，会话 token 能上 WS", async () => {
    const res = await fetch(`${base()}/auth/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(200);
    const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());

    const ws = await tryConnect(`ws://127.0.0.1:${hub.port}/ws?token=${token}`, ORIGIN);
    expect(ws).not.toBeNull();
    ws!.close();
  });

  it("POST /auth/session：错误根 token → 401；会话 token 不能换发新会话 → 401", async () => {
    const bad = await fetch(`${base()}/auth/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(64) }),
    });
    expect(bad.status).toBe(401);

    const { token: session } = issueSessionToken(TOKEN);
    const relay = await fetch(`${base()}/auth/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: session }),
    });
    expect(relay.status).toBe(401);
  });

  it("POST /auth/session：Origin 不在白名单 → 403（CSRF 防线）", async () => {
    const res = await fetch(`${base()}/auth/session`, {
      method: "POST",
      headers: { origin: "https://evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /auth/check：有效 token（根或会话）→ 204，无效 → 401", async () => {
    const ok = await fetch(`${base()}/auth/check`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(204);

    const { token: session } = issueSessionToken(TOKEN);
    const okSession = await fetch(`${base()}/auth/check`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(okSession.status).toBe(204);

    const bad = await fetch(`${base()}/auth/check`, {
      headers: { authorization: `Bearer nope` },
    });
    expect(bad.status).toBe(401);

    const missing = await fetch(`${base()}/auth/check`);
    expect(missing.status).toBe(401);
  });
});

describe("认证失败限速（独立 Hub 实例，避免污染其他用例的计数）", () => {
  let hub: RunningHub;

  beforeAll(async () => {
    hub = await startHub(loadConfig({ ZAGENT_TOKEN: TOKEN, ZAGENT_PORT: "0" }));
  });

  afterAll(async () => {
    await hub.close();
  });

  it("连续认证失败后，同 IP 即使 token 正确也被拒绝（WS 与 HTTP 同一计数）", async () => {
    // 打满失败窗口（阈值 10）：混合 WS 坏 token 与 HTTP 坏 token
    for (let i = 0; i < 5; i++) {
      expect(
        await tryConnect(`ws://127.0.0.1:${hub.port}/ws?token=${"b".repeat(64)}`, ORIGIN),
      ).toBeNull();
    }
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${hub.port}/auth/check`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    }

    // 正确凭证也进不来：429 / 连接被拒
    const blockedHttp = await fetch(`http://127.0.0.1:${hub.port}/auth/check`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(blockedHttp.status).toBe(429);
    expect(
      await tryConnect(`ws://127.0.0.1:${hub.port}/ws?token=${TOKEN}`, ORIGIN),
    ).toBeNull();
  }, 30000);
});
