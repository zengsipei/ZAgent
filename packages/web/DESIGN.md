---
name: ZAgent
description: 手机优先的远程终端 PWA——浏览器驱动本地容器内的 Claude Code / codex
---

<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

# Design System: ZAgent

## Overview

**Creative North Star: "The Silent Cockpit"（无声驾驶舱）**

ZAgent 的视觉系统是一间深夜的驾驶舱：仪表只在需要时发光，其余一切退入黑暗。终端视口是唯一的主角，UI chrome 的存在方式是「几乎不存在」——状态条、辅助键条、会话切换都是舱内仪表，精密、安静、伸手即达。参照 Linear 的克制与状态清晰、Ghostty / iTerm2 的零装饰终端血统、Termius 的移动端辅助键处理。

系统明确拒绝两个方向：SaaS 仪表盘味（卡片网格、渐变按钮、营销感组件）与装饰性极客风（CRT 扫描线、霓虹辉光、赛博朋克贴纸）。终端美学靠等宽字体与克制的深色本身成立，不靠装饰。

**Key Characteristics:**
- 深色为默认而非主题选项；夜间弱光舒适，对比度达 WCAG AA
- Restrained 色彩策略：深色微色相中性色 + 单一 teal 强调 ≤10%
- 动效只传达状态（150–250ms），永不装饰；全部提供 reduced-motion 降级
- 移动端拇指热区优先，触控目标 ≥44px

## Colors

**The Restrained Rule.** 深色微色相中性色承载一切表面；单一青绿（teal）强调色只出现在主操作、当前选中与状态指示上，占任一屏幕 ≤10%。它的稀缺就是它的意义。

- **强调色**：青绿 / teal 色相锚点——冷静精密，有终端血统但不赛博朋克，弱光下舒适。具体色值 `[to be resolved during implementation]`（OKLCH，深色底上需过 AA）。
- **中性色**：深色近黑背景 + 一层稍亮的面板中性色（状态条、键条、抽屉），微量色相偏向 teal（chroma 0.005–0.015），不默认偏暖。具体梯度 `[to be resolved during implementation]`。
- **语义状态色**：连接中 / 已附加 / 断开 / 会话退出需要可区分的状态色汇（success / warning / error / info），实现时从终端 ANSI 色汇附近取值以保持血统一致。

## Typography

**Body Font:** 技术感 sans（UI chrome：状态条、按钮、标签、会话列表）`[font pairing to be chosen at implementation]`
**Label/Mono Font:** 终端等宽（xterm 视口及所有会话 ID、路径、命令等数据值）

**Character:** 单一 sans 承担全部 UI 层级（product 寄存器：固定 rem 刻度、1.125–1.2 紧比率），等宽字体只属于终端内容与数据值——两个世界边界清晰，UI 不伪装成终端，终端不被 UI 稀释。中文混排以 sans 侧的中文字form为准，等宽只用于 ASCII 数据值。

## Elevation

**The Flat-By-Default Rule.** 表面平坦，深度靠中性色分层（背景 / 面板两层）而非阴影表达；阴影只允许出现在真正浮起的临时层（抽屉、菜单），且是低调的环境影。动效能量为 Restrained：只有状态变化，无编排入场。

## Do's and Don'ts

### Do:
- **Do** 让终端视口占据一切可让的空间；chrome 能收起的都收起。
- **Do** 把连接状态（连接中 / 已附加 / 断开 / 退出）做成永远诚实可见的仪表，用语义状态色区分。
- **Do** 保证触控目标 ≥44×44px，辅助键条落在拇指热区。
- **Do** 每个动效写 `prefers-reduced-motion: reduce` 降级；过渡控制在 150–250ms。
- **Do** 深色底上验证正文对比 ≥4.5:1——灰字在深底上是最常见的失败点。

### Don't:
- **Don't** SaaS 仪表盘味：卡片网格、渐变按钮、hero 指标、营销感组件（PRODUCT.md 反参照，原文引用）。
- **Don't** 装饰性极客风：CRT 扫描线、霓虹辉光、赛博朋克贴纸（PRODUCT.md 反参照，原文引用）。
- **Don't** 在击键回显路径上加任何视觉延迟或装饰动效。
- **Don't** 让强调色出现在非交互、非状态的地方；teal 稀缺即意义。
- **Don't** 用 `border-left` 色条、gradient text、玻璃拟态——共享绝对禁令全部适用。
