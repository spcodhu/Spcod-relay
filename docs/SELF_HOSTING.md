# 自托管与运行配置

快速部署请优先阅读[一键部署教程](DEPLOYMENT.md)（[English](DEPLOYMENT.en.md)）。本文说明可调整的运行参数和进阶场景。

## 部署架构

`./deploy.sh` 使用 `deploy/docker-compose.yml`：

- `relay`：从当前源码构建，容器内监听 8787；无域名时默认暴露 `0.0.0.0:8787`，启用域名后仅绑定 `127.0.0.1:8787`。
- `caddy`：仅在启用 `tls` profile 时运行，占用 80/443，自动处理证书和 WebSocket 反代。
- `relay.env`：保存域名、访问密钥和限额，权限为 0600，已被 Git 忽略。
- Docker 数据卷：只保存 Caddy 证书与配置；relay 消息队列不持久化。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DOMAIN` | 空 | TLS 域名；建议通过 `./deploy.sh --domain <域名>` 设置 |
| `RELAY_ACCESS_KEY` | 脚本自动生成 | 自托管访问密钥；公网实例不要留空 |
| `RELAY_BIND` | `0.0.0.0` | relay 宿主机端口绑定地址；启用 TLS 时脚本改为 `127.0.0.1` |
| `RELAY_PORT` | `8787` | 无域名模式暴露的宿主机端口 |
| `CADDY_HTTP_PORT` | `80` | Caddy HTTP 宿主机端口，可用 `--http-port` 设置 |
| `CADDY_HTTPS_PORT` | `443` | Caddy HTTPS/HTTP/3 宿主机端口，可用 `--https-port` 设置 |
| `ALLOW_LEGACY_WS` | `true` | 无 ticket 旧客户端兼容；配置访问密钥后仍强制 ticket |
| `CORS_ALLOWED_ORIGINS` | 空 | 外部 PWA origin 白名单，多个完整 origin 用英文逗号分隔 |
| `STATIC_DIR` | `/app/public` | 容器内 PWA 静态目录；不存在时显示说明页 |
| `QUEUE_MAX` | `1000` | 每 channel、每方向离线帧上限 |
| `QUEUE_TTL_HOURS` | `72` | 离线帧存活时长 |
| `MAX_CHANNELS` | `4096` | 最大 channel 数 |
| `MAX_DEVICES_PER_CHANNEL` | `16` | 每 channel 最大设备数 |
| `QUEUE_BYTES_MAX_MB` | `64` | 全局离线队列内存预算 |
| `HEARTBEAT_MS` | `30000` | WebSocket ping/pong 间隔 |
| `MAX_BUFFERED_BYTES` | `1048576` | 单连接发送缓冲预算 |
| `TICKET_RATE_PER_MIN` | `60` | 每 IP 每分钟票据签发上限 |
| `TRUST_PROXY` | `false` | 仅在可信反向代理后设为 `true`，用于读取转发 IP；TLS 模式自动启用 |

修改 `deploy/relay.env` 后运行 `./deploy.sh` 使配置生效。

## PWA 托管与 origin

relay 可以通过 `STATIC_DIR` 托管手机端 PWA 构建产物。完全自托管 PWA 时，在 Compose 的 relay 服务中把构建产物只读挂载到 `/app/public`，再重新部署。

两种连接方式：

1. **现有官方 PWA + 自托管 relay**：保持 PWA origin 不变，并把该 origin 加入 `CORS_ALLOWED_ORIGINS`。
2. **PWA 与 relay 同源**：无需额外 CORS 配置。不同 origin 的 IndexedDB 不共享，首次使用需要重新配对；不要导出私钥进行迁移。

## 使用其他反向代理

如果不使用内置 Caddy，可运行 `./deploy.sh` 后直接代理 `127.0.0.1:8787`，或手工把 `RELAY_BIND` 改为 `127.0.0.1`。代理必须：

- 终止 TLS，并将外部 `wss://<域名>` 转发到 relay；
- 转发 WebSocket 的 `Upgrade` 与 `Connection` 头；
- 设置可信的 `X-Forwarded-For`，然后将 `TRUST_PROXY=true`；
- 转发 `/v1/tickets`、`/health` 和 channel WebSocket 路径。

最小 Caddy 配置示例：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## 安全与数据说明

- 访问密钥只控制 relay 准入，不是手机或电脑的端到端加密私钥。
- 长期访问密钥用于换取 30 秒单次 ticket，不应写入 WebSocket URL。
- relay 不记录消息明文；离线队列只存在内存中，重启后由客户端重连恢复。
- 定期更新源码并重新部署。更新前可备份 `deploy/relay.env`，不要备份或公开客户端私钥。
