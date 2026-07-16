# IPv6 直连部署指南（兜底路径，ADR-0007）

> **这是兜底，不是主路径**。主路径是 Tailscale（零公网入站，见 `docs/deploy.md`「远程接入」节）；仅当 Tailscale 控制面不可达或政策变化时启用本方案。启用期间光猫防攻击保护关闭、全内网设备裸对公网 v6 扫描——恢复主路径后建议把开关关回并 `docker compose --profile public down`。

把 Hub 经 IPv6 直连安全地暴露到公网：DDNS-v6 + WSS + 应用层完整认证。前置阅读：`docs/deploy.md`（基础容器部署）。

## 前提

- 一个域名，DNS 托管在有 API 的服务商（DDNS 与证书都用它）
- 家宽有公网 IPv6（国内三大运营商家宽普遍下发 /60 前缀）
- 手机蜂窝有 IPv6（移动/电信/联通蜂窝普遍有；个别场景缺失时走兜底路径）

## 1. 光猫 / 路由器

- 关闭光猫「安全 → 防火墙 → 防攻击保护」（spike 实测：该开关是 v6 入站拦截元凶）。**注意固件升级可能重置此开关**——直连突然不通时先查这里。
- 确认宿主机拿到全局 IPv6 地址（`2xxx:` 开头）：Windows `ipconfig`、Linux `ip -6 addr`。
- 该开关关闭后，v6 入站安全完全落在各内网设备自身防火墙上：确认宿主机防火墙只放行 80/443（Caddy），其余设备防火墙未裸奔。

## 2. Windows 宿主防火墙（Docker Desktop 部署）

放行 Caddy 的入站端口：

```powershell
New-NetFirewallRule -DisplayName "ZAgent Caddy" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
```

Docker Desktop 的端口发布默认双栈（v4+v6）。验证 v6 监听：`netstat -an | findstr :443` 应有 `[::]:443`。

## 3. DDNS-v6

推荐 [ddns-go](https://github.com/jeessy2/ddns-go) 常驻，把宿主机 v6 地址同步到 `zagent.example.com` 的 AAAA 记录：

```bash
docker run -d --name ddns-go --restart unless-stopped --network host jeessy/ddns-go
# 打开 http://localhost:9876 配置：服务商 API、IPv6 获取方式（网卡）、域名
```

（Docker Desktop 无 host 网络时，用 Windows 版 ddns-go 或计划任务脚本均可；要点只是 AAAA 记录跟住动态前缀。）

## 4. TLS + 反代（Caddy sidecar）

`.env` 追加：

```bash
ZAGENT_DOMAIN=zagent.example.com
# Origin 白名单必须含公网域名，否则 WS 会被 Hub 拒绝
ZAGENT_EXTRA_ORIGINS=https://zagent.example.com
# 通知点开回跳（若已配通知）
ZAGENT_PWA_URL=https://zagent.example.com
```

拉起（`public` profile 启用 Caddy）：

```bash
docker compose --profile public up -d --build
```

Caddy 自动向 Let's Encrypt 申请证书（HTTP-01，走 80 端口）并续期，反代到容器内网的 `hub:7433`。

## 5. 验证

1. 桌面浏览器（非本机网络更佳）打开 `https://zagent.example.com` → token 表单 → 粘贴 `ZAGENT_TOKEN` 换发会话 token → 会话列表。
2. 手机关 WiFi 走蜂窝：同上可连、可交互、锁屏回来自动重连。
3. 认证防线自检：
   - 无 token 的 WS/页面请求被拒；
   - 连续 10 次错误 token 后，同 IP 正确 token 也被拒（15 分钟窗口）——失败限速生效。

## 认证模型（ADR-0007）

- `ZAGENT_TOKEN` 是根凭证：只用于在 token 表单换发 30 天期会话 token，浏览器持久化的是会话 token。
- 会话 token 无状态（HMAC），**吊销 = 更换 `ZAGENT_TOKEN` 并重启**——怀疑泄露时这样做，所有已发会话 token 立即全部失效。
- 根 token 安全等级等同 API key：不进聊天记录、不进截图。

## 再兜底：VPS 中继（frp）——已移出一期，留档备查

ADR-0007 二次改道后 VPS 中继移出一期（兜底职责由 IPv6 直连承担，不再为此购置 VPS）；以下配方留档，仅当 Tailscale 与 IPv6 直连双双不可用时参考。

蜂窝 v6 缺失或直连不可用时，用一台国内 VPS 跑 [frp](https://github.com/fatedier/frp)：

VPS 侧 `frps.toml`（80/443 备案限制时换高位端口）：

```toml
bindPort = 7000
auth.token = "换成长随机串"
```

本地侧把 frpc 加入 compose（或直接跑二进制），`frpc.toml`：

```toml
serverAddr = "你的VPS-IP"
serverPort = 7000
auth.token = "同上"

[[proxies]]
name = "zagent"
type = "tcp"
localIP = "zagent-caddy"   # 仍经 Caddy 终结 TLS；域名 AAAA/A 记录指向 VPS
localPort = 443
remotePort = 443
```

frp 只是 TCP 搬运工，TLS 与认证仍由 Caddy + Hub 承担；VPS 被攻破也拿不到明文与凭证（但可 DoS，属可接受风险）。

## 故障速查

| 症状 | 先查 |
| --- | --- |
| 蜂窝直连突然不通 | 光猫防攻击开关是否被固件升级重置；AAAA 记录是否跟上前缀变化 |
| 证书申请失败 | 80 端口是否可从公网 v6 到达（防火墙/光猫） |
| 页面开但 WS 连不上 | `ZAGENT_EXTRA_ORIGINS` 是否含 `https://域名` |
| 正确 token 也被拒 | 15 分钟失败限速窗口内有过暴力尝试（等窗口过或重启 Hub） |
