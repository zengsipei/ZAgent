# ZAgent

浏览器远程驱动本地编程 CLI（claude / codex / bash）。设计与术语见 `CONTEXT.md` 与 `docs/adr/`。

## 结构

- `packages/protocol` — WS 信封协议的唯一 TS 源（前后端共享，ADR-0004）
- `packages/hub` — 会话宿主服务：`ws` + `node-pty`，仅监听 127.0.0.1，token + Origin 底线认证（ADR-0003）
- `packages/web` — Vite + React + xterm.js 终端页

## 本地开发

```bash
npm install
cp .env.example .env   # 填入 ZAGENT_TOKEN（≥32 字符随机串）
npm run dev:hub        # ws://127.0.0.1:7433/ws
npm run dev:web        # http://localhost:5173
```

浏览器打开 `http://localhost:5173/?token=<ZAGENT_TOKEN>`（token 会存入 localStorage 并从地址栏抹掉）。

## Docker 部署

```bash
cp .env.example .env   # 填入 ZAGENT_TOKEN
docker compose up -d --build
```

浏览器打开 `http://localhost:7433/?token=<ZAGENT_TOKEN>`。首次登录 CLI、凭证外置与复活路径见 `docs/deploy.md`。

## 测试

```bash
npm run typecheck
npm test
```
