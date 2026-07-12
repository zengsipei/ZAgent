# ZAgent — 远程控制本地编程 CLI

浏览器（手机优先）远程驱动本地 Docker 容器内的 Claude Code / codex 等编程 CLI。PTY + WebSocket 伪终端为一期主轴，结构化 IM 对话为二期方向。自用 + 学习项目，单用户自托管。

设计定型于 2026-07-09 的 grilling session，关键取舍见 `docs/adr/`。

## 词汇表（规范术语）

- **Hub** — 容器内常驻的会话宿主服务（Node/TS：`ws` + `node-pty`）。持有全部 PTY、提供 WS 接口、管理会话生命周期。别名「本地 agent」；为避免与 claude/codex 这类 AI agent 撞名，本项目文档一律用 Hub。
- **会话（Session）** — Hub spawn 的一个被控 CLI 进程及其元数据 `{id, type, 命令模板, cwd, claudeSessionId?}`。一期 `type` 仅有 `pty`。Hub 只管理自己 spawn 的会话，不接管外部已有终端。
- **命令模板（Command Template）** — 新建会话时的预设命令（claude / codex / bash / 自定义参数）。PTY 模式天然命令无关，支持任意 CLI 是免费的。
- **信封（Envelope）** — WS 上的统一消息格式 `{channel, type, payload}`，JSON 编码；PTY 字节流以 base64 作为 payload。协议类型定义前后端共享同一份 TS 源。
- **通道（Channel）** — 信封的路由键。`control` = 会话管理（list / create / kill / attach / resize）；`session:<id>` = 具体会话的输入输出流。不另设 REST API。
- **回放缓冲（Ring Buffer）** — Hub 为每个会话保留的最近若干 MB 输出，attach 时重放以恢复画面。
- **重绘抖动（Resize Nudge）** — attach 重放后微调一次 PTY 尺寸，逼全屏 TUI 整屏重绘以收敛画面。
- **多端广播** — 同一会话允许多个连接：输出广播、输入不加锁、最后 resize 者决定尺寸。
- **复活（Resurrect）** — 容器重启后活动任务丢失，用命令模板里的 `claude --continue` / `claude --resume` 预设新建会话找回对话上下文（终端画面与进行中任务不可恢复）；不做 session id 簿记。
- **凭证卷（Credentials Mount）** — `~/.claude`、`~/.codex`、git/gh 凭证等登录态目录，挂载到容器外持久化（WSL bind 或 named volume 由部署配置决定）。安全等级等同 API key。
- **边缘认证（Edge Auth）** — Cloudflare Access 在 CF 边缘完成的身份验证；未认证流量不触达 Hub。
- **应用层底线（App-layer Floor）** — Hub 内写死、不可配置关闭的最低认证：长随机 token 校验 + Origin 白名单。
- **辅助键条（Key Bar）** — 移动端常驻虚拟按键行（Esc / Tab / Ctrl / 方向 / Shift+Tab）。没有它，Claude Code TUI 在手机上不可操作。
- **headless 会话** — 二期的结构化会话类型（`claude -p --output-format stream-json` / `codex exec --json`），聊天 UI 与 IM 接入的数据源。明确不从 PTY 流中刮取对话。

## 架构（一期）

```
手机 / 桌面浏览器 (PWA: xterm.js + 辅助键条)
        │ WSS（信封协议）
        ▼
Cloudflare Access（边缘认证）
        │
cloudflared（sidecar 容器，出站隧道）
        │ 容器内网（Hub 不监听公网）
        ▼
Hub（Node/TS）── 应用层底线认证
  ├─ Session[pty] ⇄ claude / codex / bash（node-pty spawn）
  │       └─ ring buffer · 多端广播
  └─ control 通道（list / create / kill / attach / resize）

claude hooks (Notification / Stop) ──► ntfy / Bark ──► 手机推送
```

单容器多会话：Hub 与它 spawn 的全部 CLI 进程同容器（fat image 含常用工具链）。项目代码可见性属于部署配置（volumes 自行挂载，git clone 或 bind mount 均可），不是产品功能。

## 一期范围

1. Dockerfile + compose（Hub 容器 + cloudflared sidecar；凭证/工作区挂载留给配置）
2. Hub：WS 信封协议、Session 管理（spawn / ring buffer / 断线不杀 / 多端广播）、token + Origin 底线认证
3. 前端：会话列表与新建（选 cwd + 命令模板）、xterm.js 终端页、辅助键条、PWA
4. hook → ntfy/Bark 推送闭环

## 二期方向（架构已预留，不实施）

headless 会话 + 聊天 UI / IM 接入；Web Push；会话级容器隔离。

## 待验证假设

- **CF 国内击键延迟可接受** — 动工第一周用 ttyd + CF Tunnel 实测；不达标则降级 frp + VPS，并按 ADR-0003 触发「应用层认证转必须」条款。
- Docker Desktop 常驻内存成本（2–4 GB）长期可接受。
