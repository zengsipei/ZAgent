# fat image（ADR-0002）：Hub 与它 spawn 的全部 CLI 同容器，
# 预装 claude / codex CLI 与个人常用工具链，不做通用化。
FROM node:22-bookworm

# 常用工具链 + GitHub CLI（git / curl / python3 已随基础镜像自带）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep jq less procps vim tmux openssh-client \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
RUN npm ci && npm run build -w @zagent/web

# 凭证外置（ADR-0002）：CLAUDE_CONFIG_DIR 把 ~/.claude.json 一并收进 /root/.claude，
# GIT_CONFIG_GLOBAL 把 git 全局配置（含 gh auth setup-git 写入的 credential helper）
# 固定到挂载卷内，容器销毁重建后登录态保持。
ENV CLAUDE_CONFIG_DIR=/root/.claude \
    GIT_CONFIG_GLOBAL=/root/.config/git/config \
    ZAGENT_HOST=0.0.0.0 \
    ZAGENT_STATIC_DIR=/app/packages/web/dist \
    ZAGENT_CWDS=/workspace

RUN mkdir -p /workspace

EXPOSE 7433
CMD ["npm", "run", "start", "-w", "@zagent/hub"]
