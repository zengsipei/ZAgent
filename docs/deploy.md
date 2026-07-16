# 部署指南

两种部署形态（ADR-0002 适用域，2026-07-16 更新）：

- **Windows 本机直跑（日用形态）**——Hub 与被控 CLI 直接跑在本机，控制的就是本机工作区；零容器开销。适用于 owner 人在环的日常使用。
- **Docker 单容器（服务器形态）**——面向远程 Linux 主机（如 1panel 管理的服务器）：fat image、凭证外置挂载卷、auto-approve 爆炸半径锁定在容器内（ADR-0002 的安全论证正是为无人值守场景所立）。控制的是服务器上的工作区。

「远程接入：Tailscale」一节两种形态通用。

## Windows 本机直跑（日用形态）

前提：Node ≥ 22、装过依赖（`npm install`）、web 产物已构建：

```bash
npm run build -w @zagent/web
```

仓库根 `.env`（Hub 启动时自动加载，不覆盖已有环境变量）：

```bash
ZAGENT_TOKEN=<至少 32 字符长随机串>
# 自身源必须显式加白：POST /auth/session 校验 Origin，漏了报「token 未通过验证」
ZAGENT_ALLOWED_ORIGINS=http://localhost:7433,http://127.0.0.1:7433,https://<机器名>.<tailnet>.ts.net
ZAGENT_STATIC_DIR=F:\zsp\Learn\ZAgent\packages\web\dist
# 可选：新建会话的 cwd 预设列表
# ZAGENT_CWDS=F:\zsp\Learn,F:\zsp\Work
```

启动：

```bash
npm run start -w @zagent/hub
```

常驻可用最小化独立窗口（cmd）：

```bat
start "ZAgent Hub" /min cmd /k "cd /d F:\zsp\Learn\ZAgent && npm run start -w @zagent/hub"
```

与 Docker 形态的差异：

- 凭证与历史直接用本机登录态（`~/.claude`、`~/.codex`、git/gh），无卷概念；claude 历史按 cwd 分桶的复活语义不变（ADR-0005）。
- 通知闭环的 hooks 补种由 Docker entrypoint 负责；直跑形态如需推送，参照 `docker/entrypoint.sh` 把 `docker/zagent-notify` 挂进本机 claude `settings.json` hooks 与 codex `config.toml`。
- Hub 从 Claude Code 会话内的终端启动时，spawn 前会剥离 `CLAUDECODE` 等会话标记，被控 CLI 不会自认嵌套子会话。
- auto-approve 的爆炸半径是本机（无容器边界）——日用为 owner 人在环场景，已接受；无人值守放权跑请用服务器形态。

## Docker 单容器（服务器形态）

按 ADR-0002 单容器多会话：Hub 与它 spawn 的全部 CLI 进程同容器（fat image，预装 claude / codex / git / gh / node 等）。容器无状态可重建，登录态全部外置在挂载卷里。**目标环境是远程 Linux 主机**（如 1panel 管理的服务器，面板可直接编排 compose）；Windows 本机的 Docker Desktop 仅用于验证镜像，不作日用（常驻内存 2–4 GB）。

### 拉起

```bash
cp .env.example .env   # 填入 ZAGENT_TOKEN（≥32 字符长随机串）
docker compose up -d --build
```

浏览器打开 `http://localhost:7433/?token=<ZAGENT_TOKEN>`。Hub 在容器内监听 0.0.0.0，宿主机端口映射仅绑定 `127.0.0.1`（远程接入见下方 Tailscale 节，ADR-0007）。

### 首次登录（一次性，凭证外置）

```bash
docker exec -it zagent-hub claude          # 跟随 OAuth 流程登录 Claude
docker exec -it zagent-hub codex login     # 登录 Codex（可选）
docker exec -it zagent-hub gh auth login   # 登录 GitHub
docker exec -it zagent-hub gh auth setup-git   # git 推拉走 gh 凭证
docker exec -it zagent-hub git config --global user.name  "你的名字"
docker exec -it zagent-hub git config --global user.email "你的邮箱"
```

登录态落在 named volumes（`claude-config` / `codex-config` / `gh-config` / `git-config`），安全等级等同 API key。之后 `docker compose down && docker compose up -d` 随便重建，登录态保持。镜像内 `CLAUDE_CONFIG_DIR=/root/.claude`，`~/.claude.json` 也一并收进凭证卷。

### 工作区

产品只认容器内路径 `/workspace`（新建会话的 cwd 预设）。如何填充属部署配置：

- **推荐**：`docker exec -it zagent-hub bash` 进容器把仓库 clone 进 `workspace` 卷（容器内原生 I/O）。
- **替代**：把 compose 中 `workspace:/workspace` 换成 bind mount（如 `/mnt/f/code:/workspace`）。跨 OS bind 的 I/O 慢 5–20 倍且文件监听不可靠，自行取舍。

## 远程接入：Tailscale（主路径，ADR-0007；两种形态通用）

Hub 所在机器与手机都装 Tailscale 并登录同一 tailnet（admin console 建议对常用设备关闭 key expiry，免得半年重登一次）。Hub 所在机器上：

```bash
tailscale serve --bg 7433    # 把 127.0.0.1:7433 反代为 tailnet 内 HTTPS，证书自动
tailscale serve status       # 查看地址，形如 https://<机器名>.<tailnet>.ts.net
```

serve 指向 `127.0.0.1:7433`，两种形态一致：直跑即 Hub 本体，Docker 即宿主机端口映射；服务器形态则在服务器上装 tailscale 并 serve，手机访问服务器的 ts.net 地址。

把该地址加进 Origin 白名单——直跑形态写进 `.env` 的 `ZAGENT_ALLOWED_ORIGINS`（见上）；Docker 形态用 `ZAGENT_EXTRA_ORIGINS` 并重建容器：

```bash
ZAGENT_EXTRA_ORIGINS=https://<机器名>.<tailnet>.ts.net
ZAGENT_PWA_URL=https://<机器名>.<tailnet>.ts.net   # 若配了通知，点开推送回到这里
```

手机开着 Tailscale，浏览器访问该地址即可（PWA 安装同源）。注意：

- serve 配置持久化，宿主机重启自动恢复；`tailscale serve --https=443 off` 可清除。
- 本机代理（Clash 类）会吞 `*.ts.net`：桌面浏览器验证时需绕过；手机端 Tailscale 与代理类 VPN 互斥，用时切换。
- 手机蜂窝与家宽之间通常 WireGuard P2P 直连（实测 p50≈56ms），打洞失败自动退 DERP（跨境，慢但可用）。
- Tailscale 控制面不可达导致失联时，兜底路径见 `docs/deploy-public.md`（IPv6 直连，`--profile public`）。

## 通知闭环（#8，可选）

派活 → 手机收到推送 → 回来看结果。以下机制为 Docker 形态（直跑形态的差异见上方直跑节）。在 `.env` 里配置推送目标（二选一或都配）：

```bash
ZAGENT_NTFY_URL=https://ntfy.sh/你的-topic-长随机串   # ntfy（Android/iOS 装 ntfy app 订阅该 topic）
ZAGENT_BARK_URL=https://api.day.app/你的DeviceKey     # Bark（iOS）
ZAGENT_PWA_URL=https://zagent.example.com             # 点开通知回到的 PWA 地址（可选）
```

工作机制：

- 镜像内置 `zagent-notify` 推送脚本；容器 entrypoint 启动时向凭证卷**幂等补种** claude hooks（`settings.json` 的 Notification / Stop → `zagent-notify`）与 codex notify（`config.toml` 的 `notify`）。缺了才写、不覆盖已有配置，重建容器无需手动重配。
- claude 需要权限确认/空闲（Notification）与回答完成（Stop）、codex 回合完成（agent-turn-complete）都会推送；标题携带会话 cwd 目录名以辨识来源。
- 公开 ntfy 服务器的 topic 名等于订阅口令，务必用长随机串。

## 复活路径（ADR-0005）

Hub/容器重启会杀死全部会话进程——进行中任务与终端画面丢失是已接受代价。对话上下文在新建 claude 会话时用「附加参数」找回：

- `--continue`：直接接上该 cwd 最近一次对话。
- `--resume`：交互式列表挑选。

注意 claude 历史按 cwd 分桶：必须选原对话所在的工作目录，否则无可续、列表为空。不做 session id 簿记；直跑形态历史在本机 `~/.claude`，Docker 形态在挂载卷里，重启/重建均不影响。
