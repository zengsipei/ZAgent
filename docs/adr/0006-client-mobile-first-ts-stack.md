# ADR-0006: 手机优先客户端、hook 推送闭环、TS 全栈

- 状态：已接受
- 日期：2026-07-09

## 背景

典型使用时刻是「人不在电脑前」，手上的设备是手机。虚拟键盘没有 Esc/Ctrl/Tab/方向键，而这些是 Claude Code TUI 的命脉（Esc 中断、方向键选菜单、Shift+Tab 切模式、数字选项）——没有辅助键条，手机上字面意义不可操作。远程派活的闭环依赖「完成/需确认」推送，缺了就退化为手动轮询刷页面。

## 决策

- **手机优先**：辅助键条（Esc/Tab/Ctrl/方向/Shift+Tab/数字）、虚拟键盘遮挡处理、PWA 全屏为一期 P0；桌面浏览器顺带支持。
- **通知一期就做**：容器内为 claude 配 `Notification`/`Stop` hooks（codex 用 notify 配置），curl 推送到 ntfy/Bark。不做 Web Push（service worker + VAPID 工作量大、iOS 受限），留二期。
- **TS 全栈**：Hub 用 Node/TS（`node-pty` + `ws`，与 xterm.js 同生态、VS Code 同款组合）；前端 Vite + React + xterm.js；信封协议类型定义一份 TS 源前后端共享，协议漂移由编译器兜住。

否决 Go/Rust agent：容器内运行使「单二进制」优势被抹平，且协议类型需两语言手动同步；本项目学习目标（PTY/WS/终端模拟链路）的参考实现以 TS 生态最丰富。

## 后果

- 移动端整包工作量（键条/遮挡/PWA）进一期，是范围内最大的前端成本项。
- 通知依赖第三方推送通道（ntfy/Bark），自用可接受；hook 推送同时是二期 IM 的第一块砖（见 ADR-0004）。
