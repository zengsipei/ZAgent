// 容器化部署面：ZAGENT_HOST 覆盖监听地址、ZAGENT_STATIC_DIR 托管 web 构建产物。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHub, type RunningHub } from "../src/server.js";
import { TOKEN } from "./helpers.js";

let hub: RunningHub;
let staticDir: string;

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "zagent-static-"));
  writeFileSync(join(staticDir, "index.html"), "<html>zagent-index</html>");
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log('app')");
  hub = await startHub(
    loadConfig({
      ZAGENT_TOKEN: TOKEN,
      ZAGENT_PORT: "0",
      ZAGENT_HOST: "0.0.0.0",
      ZAGENT_STATIC_DIR: staticDir,
    }),
  );
});

afterAll(async () => {
  await hub.close();
  rmSync(staticDir, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.port}${path}`);
}

describe("ZAGENT_HOST 覆盖监听地址", () => {
  it("监听 0.0.0.0（容器内网），默认仍是 loopback", async () => {
    expect(hub.address).toBe("0.0.0.0");
    const loopbackHub = await startHub(loadConfig({ ZAGENT_TOKEN: TOKEN, ZAGENT_PORT: "0" }));
    expect(loopbackHub.address).toBe("127.0.0.1");
    await loopbackHub.close();
  });
});

describe("静态文件服务", () => {
  it("根路径返回 index.html", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("zagent-index");
  });

  it("资源文件按扩展名给 content-type", async () => {
    const res = await get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  it("未知路径回落 index.html（SPA 路由）", async () => {
    const res = await get("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("zagent-index");
  });

  it("路径穿越被拒", async () => {
    const res = await get("/..%2f..%2f..%2fetc%2fpasswd");
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      // 若被 URL 规范化吞掉穿越段则必须落回 index.html，绝不能读到根外文件
      expect(await res.text()).toContain("zagent-index");
    }
  });

  it("畸形编码不带崩 Hub：返回 400，后续请求照常", async () => {
    const bad = await get("/%");
    expect(bad.status).toBe(400);
    const ok = await get("/");
    expect(ok.status).toBe(200);
  });
});
