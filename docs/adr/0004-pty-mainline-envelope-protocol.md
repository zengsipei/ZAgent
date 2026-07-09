# ADR-0004: PTY 主轴 + 信封多路复用协议，IM 走二期 headless 会话

- 状态：已接受
- 日期：2026-07-09

## 背景

「先做 PTY 终端、后加 IM」不是演进关系而是两套系统：PTY 流是 ANSI 转义序列渲染的 TUI 画面（Claude Code 为全屏 TUI，整屏重绘/spinner/光标跳转），从中刮取对话消息等于逆向渲染终端，极脆弱；IM 天然需要结构化事件流，而 Claude Code 有 headless 模式（`claude -p --output-format stream-json`）、codex 有 `codex exec --json`，结构化数据源现成存在。两条路线的数据模型、协议、前端形态完全不同。

## 决策

- **一期主轴走 PTY**（忠于当下真实使用方式：完整终端体验）。
- **协议从第一天起为多路复用信封**，不用裸字节流：WS 消息统一为 `{channel, type, payload}`，JSON 编码，PTY 数据 base64 为 payload；`control` 通道承载会话管理（list/create/kill/attach/resize），`session:<id>` 通道承载流量。不另设 REST。
- **Session 带类型字段**，一期仅实现 `pty`；Hub 的领域模型是「会话管理器」而非「PTY 转发器」。
- **二期 IM = 新增 `headless` 会话类型 + IM adapter**，绝不从 PTY 流刮取对话。
- hook 推送（见 ADR-0006）是 IM 方向的第一块砖（单向通知），二期在同方向续铺。

## 后果

- 信封层一期多花约一两天，换来二期加 IM 时协议与 Hub 不重写。
- base64 有 33% 膨胀，终端流量为 KB 级文本，无感知；devtools 裸眼可调试。将来需要时可换二进制帧，信封结构不变。
- 前端一期只有 xterm.js 终端形态；聊天 UI 属于二期 headless 会话的消费端。
