# Docker 部署指南

按 ADR-0002 单容器多会话：Hub 与它 spawn 的全部 CLI 进程同容器（fat image，预装 claude / codex / git / gh / node 等）。容器无状态可重建，登录态全部外置在挂载卷里。

## 拉起

```bash
cp .env.example .env   # 填入 ZAGENT_TOKEN（≥32 字符长随机串）
docker compose up -d --build
```

浏览器打开 `http://localhost:7433/?token=<ZAGENT_TOKEN>`。Hub 在容器内监听 0.0.0.0，宿主机端口映射仅绑定 `127.0.0.1`（公网接入走后续隧道，ADR-0003）。

## 首次登录（一次性，凭证外置）

```bash
docker exec -it zagent-hub claude          # 跟随 OAuth 流程登录 Claude
docker exec -it zagent-hub codex login     # 登录 Codex（可选）
docker exec -it zagent-hub gh auth login   # 登录 GitHub
docker exec -it zagent-hub gh auth setup-git   # git 推拉走 gh 凭证
docker exec -it zagent-hub git config --global user.name  "你的名字"
docker exec -it zagent-hub git config --global user.email "你的邮箱"
```

登录态落在 named volumes（`claude-config` / `codex-config` / `gh-config` / `git-config`），安全等级等同 API key。之后 `docker compose down && docker compose up -d` 随便重建，登录态保持。镜像内 `CLAUDE_CONFIG_DIR=/root/.claude`，`~/.claude.json` 也一并收进凭证卷。

## 工作区

产品只认容器内路径 `/workspace`（新建会话的 cwd 预设）。如何填充属部署配置：

- **推荐**：`docker exec -it zagent-hub bash` 进容器把仓库 clone 进 `workspace` 卷（容器内原生 I/O）。
- **替代**：把 compose 中 `workspace:/workspace` 换成 bind mount（如 `/mnt/f/code:/workspace`）。跨 OS bind 的 I/O 慢 5–20 倍且文件监听不可靠，自行取舍。

## 复活路径（ADR-0005）

容器/Hub 重启会杀死全部会话进程——进行中任务与终端画面丢失是已接受代价。对话上下文用新建会话时的命令模板找回：

- **Claude · 继续上次对话**（`claude --continue`）：直接接上该 cwd 最近一次对话。
- **Claude · 挑选历史对话**（`claude --resume`）：交互式列表挑选。

不做 session id 簿记；凭证与历史都在挂载卷里，重建容器不影响。
