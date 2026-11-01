# 自托管指南

## 1. 准备

- 一台 Ubuntu VPS，开放 80/443。
- 一个指向 VPS 的域名。
- Docker 与 Docker Compose。
- 生成访问密钥：

```bash
openssl rand -base64 32
```

公网自托管强烈建议配置 `RELAY_ACCESS_KEY`。该密钥只控制 relay 准入，不是手机/电脑的 E2E 私钥。

## 2. 启动

```bash
git clone https://github.com/spcodhu/spcod-relay.git
cd spcod-relay
cp deploy/relay.env.example deploy/relay.env
# 编辑域名、访问密钥和 PWA origin
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml up -d
```

`docker-compose.yml` 默认使用 GHCR 镜像。若要本地构建：

```bash
docker build -t spcod-relay .
docker run -d --name spcod-relay \
  -p 127.0.0.1:8787:8787 \
  -e RELAY_ACCESS_KEY='替换为强随机密钥' \
  spcod-relay
```

## 3. Caddy HTTPS

把 `deploy/Caddyfile` 中的 `${DOMAIN}` 替换为真实域名，然后让 Caddy 加载它。Caddy 自动申请和续期证书，并转发 WebSocket。

验证：

```bash
curl https://<domain>/health
# {"ok":true,"version":2}
```

## 4. 桌面与手机配置

- 桌面：设置 → 远程控制 → 自托管，填 `wss://<domain>` 与访问密钥，测试后保存。
- 手机：设置 → 连接服务器 → 自托管，填相同地址和密钥。修改只重建连接，不会解除配对。
- 新配对 QR v3 可携带访问密钥，含密钥的 QR 不要分享。

## 5. PWA 与 origin

relay 可通过 `STATIC_DIR` 托管 PWA。PWA 源码在主仓 `apps/mobile`，构建后为 `apps/mobile/dist`：

```bash
pnpm --filter @spcode/mobile build
```

两种用法：

1. **官方 PWA 连接自托管 relay**：页面 origin 不变，现有配对可继续；自托管 relay 的 `CORS_ALLOWED_ORIGINS` 必须包含官方 PWA origin。
2. **完全自托管 PWA**：把 dist 挂到 `/app/public:ro`。不同 origin 的 IndexedDB 不共享，首次需要重新扫码，绝不导出私钥做迁移。

## 6. 主要环境变量

| 变量 | 说明 |
|---|---|
| `RELAY_ACCESS_KEY` | 可选访问密钥；公网自托管建议必填 |
| `ALLOW_LEGACY_WS` | 无 ticket 旧客户端兼容；有密钥时仍强制 ticket |
| `CORS_ALLOWED_ORIGINS` | 逗号分隔的 PWA origin 白名单 |
| `STATIC_DIR` | PWA 静态目录，默认 `/app/public` |
| `QUEUE_MAX` / `QUEUE_TTL_HOURS` | 每设备/方向队列条数与 TTL |
| `MAX_CHANNELS` / `MAX_DEVICES_PER_CHANNEL` | channel 与设备配额 |
| `QUEUE_BYTES_MAX_MB` | 全局离线队列字节预算 |
| `HEARTBEAT_MS` | ping/pong 间隔，默认 30000 |
| `MAX_BUFFERED_BYTES` | 单连接发送缓冲预算 |
| `TICKET_RATE_PER_MIN` | 每 IP 票据签发限流 |
| `TRUST_PROXY` | 仅可信反代后设为 true，用于 IP 限流 |

离线队列仅在内存中，重启不持久化。请先小范围验证，再导入正式设备。
