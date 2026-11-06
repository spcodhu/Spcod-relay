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
| `RELAY_ACCESS_KEY` | 脚本自动生成 | 自托管访问密钥；公网自托管实例不要留空 |
| `RELAY_ALLOW_ANONYMOUS` | `false` | 仅官方公共实例由 `--anonymous` 开启；忽略遗留密钥并允许无 ticket WS |
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

修改 `deploy/relay.env` 后运行 `./deploy.sh` 使配置生效。也可以由部署脚本持久切换认证模式：`--anonymous` 仅用于官方公共实例，`--access-key` 恢复自托管默认的访问密钥保护；后续普通更新会保留所选模式。

匿名模式只允许官方客户端免 ticket 建立 WebSocket，不会关闭端到端加密、channel/origin 校验或限流。启动日志中的 `auth=anonymous` / `auth=access-key` 可用于核对实际运行模式。

## PWA 托管与 origin

最终 Docker 镜像默认内置手机 PWA。构建时会从 `Dockerfile` 中 `SPCOD_PWA_REF` 固定的 Spcod 提交编译手机端，并复制到 `/app/public`；运行 `./deploy.sh` 即可完成 relay 与 PWA 部署，不需要手工挂载目录。

两种连接方式：

1. **现有官方 PWA + 自托管 relay**：保持 PWA origin 不变，并把该 origin 加入 `CORS_ALLOWED_ORIGINS`。
2. **镜像内置 PWA 与 relay 同源**：无需额外 CORS 配置，直接打开 relay 根路径。不同 origin 的 IndexedDB 不共享，首次使用需要重新配对；不要导出私钥进行迁移。

升级内置 PWA 时，维护者更新 `SPCOD_PWA_REF` 并推送仓库；部署者运行 `git pull && ./deploy.sh`。`STATIC_DIR` 仍可用于本地开发或特殊定制，但不再是默认部署步骤。

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
