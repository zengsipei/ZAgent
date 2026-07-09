import { describe, expect, it } from "vitest";

import { verifyUpgrade } from "../src/auth.js";
import { HUB_HOST, loadConfig } from "../src/config.js";

const TOKEN = "a".repeat(64);

function makeConfig(extraEnv: Record<string, string> = {}) {
  return loadConfig({ ZAGENT_TOKEN: TOKEN, ...extraEnv });
}

describe("loadConfig", () => {
  it("缺失 token 时拒绝启动", () => {
    expect(() => loadConfig({})).toThrow(/ZAGENT_TOKEN/);
  });

  it("token 过短时拒绝启动（长随机 token 是底线）", () => {
    expect(() => loadConfig({ ZAGENT_TOKEN: "short" })).toThrow(/32/);
  });

  it("监听地址是写死的 127.0.0.1，不存在配置口", () => {
    expect(HUB_HOST).toBe("127.0.0.1");
  });

  it("默认白名单含 Vite 开发端 Origin，可用环境变量追加", () => {
    const config = makeConfig({
      ZAGENT_ALLOWED_ORIGINS: "https://z.example.com, https://z2.example.com",
    });
    expect(config.allowedOrigins.has("http://localhost:5173")).toBe(true);
    expect(config.allowedOrigins.has("http://127.0.0.1:5173")).toBe(true);
    expect(config.allowedOrigins.has("https://z.example.com")).toBe(true);
    expect(config.allowedOrigins.has("https://z2.example.com")).toBe(true);
  });

  it("拒绝把通配符加入白名单", () => {
    expect(() => makeConfig({ ZAGENT_ALLOWED_ORIGINS: "*" })).toThrow(/\*/);
  });
});

describe("verifyUpgrade（WS upgrade 阶段的底线认证）", () => {
  const config = makeConfig();
  const origin = "http://localhost:5173";

  function verify(url: string | undefined, originHeader: string | undefined) {
    return verifyUpgrade({ url, headers: { origin: originHeader } }, config);
  }

  it("token 正确且 Origin 在白名单 → 放行", () => {
    expect(verify(`/ws?token=${TOKEN}`, origin)).toEqual({ ok: true });
  });

  it("缺失 token → 拒绝", () => {
    expect(verify("/ws", origin).ok).toBe(false);
  });

  it("错误 token → 拒绝", () => {
    expect(verify(`/ws?token=${"b".repeat(64)}`, origin).ok).toBe(false);
  });

  it("token 前缀匹配但不完整 → 拒绝", () => {
    expect(verify(`/ws?token=${TOKEN.slice(0, 40)}`, origin).ok).toBe(false);
  });

  it("缺失 Origin → 拒绝", () => {
    expect(verify(`/ws?token=${TOKEN}`, undefined).ok).toBe(false);
  });

  it("Origin 不在白名单 → 拒绝（即使 token 正确）", () => {
    expect(verify(`/ws?token=${TOKEN}`, "https://evil.example.com").ok).toBe(false);
  });

  it("缺失 URL → 拒绝", () => {
    expect(verify(undefined, origin).ok).toBe(false);
  });
});
