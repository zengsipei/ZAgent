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
- **多端广播** — 同一会话允许多个连接：输出广播、输入不加锁；PTY 尺寸取所有已 attach 端上报容量的最小交集（tmux 式，#9），各端 xterm 网格跟随会话尺寸、大屏留白（#10）。
- **复活（Resurrect）** — 容器重启后活动任务丢失，新建 claude 会话时在「附加参数」填 `--continue` / `--resume` 找回对话上下文（终端画面与进行中任务不可恢复）；claude 历史按 cwd 分桶，必须选原对话所在的工作目录；不设预设模板、不做 session id 簿记。
- **凭证卷（Credentials Mount）** — `~/.claude`、`~/.codex`、git/gh 凭证等登录态目录，挂载到容器外持久化（WSL bind 或 named volume 由部署配置决定）。安全等级等同 API key。
- **应用层完整认证（App-layer Auth）** — Hub 内写死、不可配置关闭：长随机根 token + Origin 白名单 + 会话 token 签发（`/auth/session` 换发 30 天期 HMAC token，前端只持久化它）+ 认证失败按 IP 限速。主路径 Tailscale 有 WireGuard 设备认证在前，这层是纵深防御；对 IPv6 直连兜底路径没有边缘认证在前，这层是唯一防线（ADR-0007）。
- **辅助键条（Key Bar）** — 移动端常驻虚拟按键行（Esc / Tab / Ctrl / 方向 / Shift+Tab）。没有它，Claude Code TUI 在手机上不可操作。
- **headless 会话** — 二期的结构化会话类型（`claude -p --output-format stream-json` / `codex exec --json`），聊天 UI 与 IM 接入的数据源。明确不从 PTY 流中刮取对话。

## 架构（一期）

```
手机 / 桌面浏览器 (PWA: xterm.js + 辅助键条)
        │ WSS（信封协议）
        │   主路径：Tailscale（设备入 tailnet，宿主机 tailscale serve 反代 HTTPS）
        │   兜底：IPv6 直连（DDNS-v6 → Caddy sidecar TLS，唯一入站口 443）——ADR-0007
        ▼
Hub（Node/TS，不监听公网）── 应用层完整认证（根 token + 会话 token 签发 + Origin 白名单 + 失败限速）
  ├─ Session[pty] ⇄ claude / codex / bash（node-pty spawn）
  │       └─ ring buffer · 多端广播（尺寸取各端容量 min）
  └─ control 通道（list / create / kill / attach / resize）

claude hooks (Notification / Stop) ──► ntfy / Bark ──► 手机推送
```

单容器多会话：Hub 与它 spawn 的全部 CLI 进程同容器（fat image 含常用工具链）。项目代码可见性属于部署配置（volumes 自行挂载，git clone 或 bind mount 均可），不是产品功能。

## 一期范围

1. Dockerfile + compose（Hub 容器 + 兜底 Caddy TLS sidecar（`public` profile，默认不启用）；凭证/工作区挂载留给配置）
2. Hub：WS 信封协议、Session 管理（spawn / ring buffer / 断线不杀 / 多端广播）、应用层完整认证（根 token + 会话 token 签发 + Origin 白名单 + 失败限速）
3. 前端：会话列表与新建（选 cwd + 命令模板）、xterm.js 终端页、辅助键条、触摸滚动、PWA
4. hook → ntfy/Bark 推送闭环

## 二期方向（架构已预留，不实施）

headless 会话 + 聊天 UI / IM 接入；Web Push；会话级容器隔离。（WebRTC DataChannel P2P 已随 ADR-0007 二次改道移出：访问设备已在 tailnet，「浏览器免装直连」动机消失。）

## 待验证假设

- ~~CF 国内击键延迟可接受~~ — **已否决**（spike #1：p50 585–943ms，结构性超标）；改道 Tailscale 主路径 + IPv6 直连兜底（ADR-0007）。
- **Tailscale 控制面国内可达性** — 主路径的结构性第三方依赖（数据面 P2P 建立后不依赖；换网后端点重协调需要），不可达时切 IPv6 直连兜底（`--profile public`）。蜂窝 v6 覆盖与光猫开关稳定性随之降为兜底路径的前提。
- Docker Desktop 常驻内存成本（2–4 GB）长期可接受。
