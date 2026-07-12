// 静态文件服务：容器化部署时由 Hub 直接托管 web 构建产物（ADR-0002 单容器），
// 浏览器与 WS 同源，省掉独立静态服务器与跨源配置。

import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** 服务 root 下的静态文件；未命中的路径回落到 index.html（SPA 单页）。 */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const rootDir = resolve(root);
  let pathname: string;
  try {
    // 畸形编码（如 /%）会抛 URIError，不能让单个坏请求带崩 Hub
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let filePath = resolve(join(rootDir, pathname));
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!isFile(filePath)) {
    filePath = join(rootDir, "index.html");
  }
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream" });
  res.end(content);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
