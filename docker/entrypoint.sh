#!/bin/sh
# 容器入口（#8）：通知配置的幂等种子。
# hooks / notify 配置落在凭证卷上（卷会遮住镜像内的 /root/.claude、/root/.codex），
# 所以「新容器开箱即有」只能在启动时补种——缺了才写，绝不覆盖用户已有配置。
set -eu

# claude hooks：Notification（要权限/空闲）与 Stop（回答完成）→ zagent-notify
CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR:-/root/.claude}/settings.json"
mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
[ -s "$CLAUDE_SETTINGS" ] || echo '{}' > "$CLAUDE_SETTINGS"
tmp="$(mktemp)"
jq '.hooks //= {}
    | .hooks.Notification //= [{"hooks": [{"type": "command", "command": "zagent-notify"}]}]
    | .hooks.Stop //= [{"hooks": [{"type": "command", "command": "zagent-notify"}]}]' \
  "$CLAUDE_SETTINGS" > "$tmp"
mv "$tmp" "$CLAUDE_SETTINGS"

# codex：notify 配置指向同一脚本（payload 走 argv）
CODEX_CONFIG=/root/.codex/config.toml
mkdir -p /root/.codex
touch "$CODEX_CONFIG"
grep -q '^notify' "$CODEX_CONFIG" || printf '\nnotify = ["zagent-notify"]\n' >> "$CODEX_CONFIG"

exec "$@"
