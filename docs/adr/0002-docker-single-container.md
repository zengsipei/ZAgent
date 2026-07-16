# ADR-0002: 整套运行于 Docker，单容器多会话

- 状态：已接受；适用域更新（2026-07-16）：Docker 为**服务器形态**（远程 Linux 主机，如 1panel 托管——无人值守 auto-approve 场景，本 ADR 的安全论证所在）；Windows 本机日用改为**直跑形态**不经容器（owner 人在环，接受本机爆炸半径，不为日用支付 Docker Desktop 常驻内存）。单容器多会话决策在 Docker 形态内不变，配方见 `docs/deploy.md`
- 日期：2026-07-09

## 背景

宿主机为 Windows 11。纯 Windows 方案受 ConPTY 约束：无 tmux、句柄不可跨进程转移。远程无人值守场景基本必然开 auto-approve（人不在电脑前无法逐个确认权限），裸机运行爆炸半径不可控。

## 决策

Hub 与其 spawn 的全部 CLI 进程运行在**同一个 Linux 容器**内（单容器多会话），docker compose 编排：

- **fat image**：预装 claude/codex CLI 及本人常用工具链，不做通用化。
- **凭证外置**：`~/.claude`、`~/.codex`、git 凭证等挂载到容器外持久化（WSL bind 或 named volume，由部署配置决定），首次 `docker exec` 登录一次。容器保持无状态可重建，「容器只有 Hub 用」。
- **代码可见性 = 部署配置**：workspace 通过 volumes 自行挂载（容器内 git clone 或 bind mount Windows/WSL 目录均可），产品只认「容器内可见路径」。一期不做 repo 管理/clone 编排。

否决**每会话一容器**：需要挂 docker.sock（等同宿主 root，安全故事崩塌）或 DinD，复杂度翻倍，而会话间隔离在单用户场景收益趋近于零——隔离边界「容器 vs 宿主机」已经存在。

## 后果

- Linux 环境使真 PTY 生态可用，Windows/ConPTY 约束消失。
- auto-approve 的爆炸半径锁定在容器内。
- Docker Desktop 常驻内存（2–4 GB)为长期成本。
- Bind mount Windows 目录时跨 OS I/O 慢 5–20 倍且文件监听不可靠——结构性坑，由部署者自行取舍（推荐 git clone 进卷或挂 WSL 侧路径）。
- 凭证卷安全等级等同 API key。
