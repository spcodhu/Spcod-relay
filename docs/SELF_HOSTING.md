# 自托管与运行配置

快速部署请优先阅读[一键部署教程](DEPLOYMENT.md)（[English](DEPLOYMENT.en.md)）。本文说明可调整的运行参数和进阶场景。

## 部署架构

`./deploy.sh` 使用 `deploy/docker-compose.yml`：

- `relay`：从当前源码构建，容器内监听 8787；无域名时默认暴露 `0.0.0.0:8787`，启用域名后仅绑定 `127.0.0.1:8787`。
- `caddy`：仅在启用 `tls` profile 时运行，占用 80/443，自动处理证书和 WebSocket 反代。
- `relay.env`：保存域名、relay 身份密钥、访问密钥和限额，权限为 0600，已被 Git 忽略。
- Docker 数据卷：只保存 Caddy 证书与配置；relay 消息队列不持久化。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DOMAIN` | 空 | TLS 域名；建议通过 `./deploy.sh --domain <域名>` 设置 |
| `RELAY_SECRET_KEY` | 脚本自动生成 | relay X25519 身份私钥；必须由 `deploy.sh` 生成并持久化，生产缺失会退出；换钥使全部设备 grant 失效 |
| `RELAY_ACCESS_KEY` | 脚本自动生成 | 自托管在 v3 准入之上叠加的 Bearer 密钥；公网自托管实例不要留空 |
| `RELAY_PUBLIC` | `false` | 仅官方实例通过 `--public` 开启；无 accessKey，但仍强制 host proof、device grant 和单次 ticket |
| `RELAY_BIND` | `0.0.0.0` | relay 宿主机端口绑定地址；启用 TLS 时脚本改为 `127.0.0.1` |
| `RELAY_PORT` | `8787` | 无域名模式暴露的宿主机端口 |
| `CADDY_HTTP_PORT` | `80` | Caddy HTTP 宿主机端口，可用 `--http-port` 设置 |
| `CADDY_HTTPS_PORT` | `443` | Caddy HTTPS/HTTP/3 宿主机端口，可用 `--https-port` 设置 |
| `CORS_ALLOWED_ORIGINS` | 空 | 外部 PWA origin 白名单，多个完整 origin 用英文逗号分隔 |
| `STATIC_DIR` | `/app/public` | 容器内 PWA 静态目录；不存在时显示说明页 |
| `QUEUE_MAX` | `1000` | device→host 每 channel 的离线帧上限；host→device 按 deviceId/wildcard 槽位分别计数 |
| `QUEUE_TTL_HOURS` | `72` | 离线帧存活时长 |
| `MAX_CHANNELS` | `4096` | 最大 channel 数 |
| `MAX_DEVICES_PER_CHANNEL` | `16` | 每 channel 最大设备数 |
| `QUEUE_BYTES_MAX_MB` | `64` | 全局离线队列内存预算 |
| `HEARTBEAT_MS` | `30000` | WebSocket ping/pong 间隔 |
| `MAX_BUFFERED_BYTES` | `1048576` | 单连接发送缓冲预算 |
| `TICKET_RATE_PER_MIN` | `60` | 每 IP 每分钟票据请求尝试上限，含失败请求 |
| `MAX_CONNS_PER_IP` | `64` | 每 IP 同时持有的 WebSocket 连接上限 |
| `TRUST_PROXY` | `false` | 前置反代后必须设为 `true` 并传递真实 `X-Forwarded-For`，否则所有访客共享代理 IP 的限额；内置 Caddy 模式自动启用 |

常规配置修改后运行 `./deploy.sh` 使配置生效；使用其他反向代理时见下文关于脚本覆盖的说明。普通更新会保留身份密钥、访问密钥和已保存模式。只有官方公共实例使用 `./deploy.sh --public`；它会持久设置公共模式并清空 accessKey，但 host 和 device 仍须通过 v3 准入，WebSocket 不接受无 ticket 连接。恢复自托管默认配置时，将 `RELAY_PUBLIC=false` 后运行 `./deploy.sh`，空 accessKey 会自动重新生成。

启动日志中的 `admission=v3 accessKey=on` / `admission=v3 accessKey=off` 可用于核对实际配置。accessKey 是叠加门槛，不能替代 host proof 或 device grant。

## PWA 托管与 origin

最终 Docker 镜像默认内置手机 PWA。构建时会从 `Dockerfile` 中 `SPCOD_PWA_REF` 固定的 Spcod 提交编译手机端，并复制到 `/app/public`；运行 `./deploy.sh` 即可完成 relay 与 PWA 部署，不需要手工挂载目录。

两种连接方式：

1. **现有官方 PWA + 自托管 relay**：保持 PWA origin 不变，并把该 origin 加入 `CORS_ALLOWED_ORIGINS`。
2. **镜像内置 PWA 与 relay 同源**：无需额外 CORS 配置，直接打开 relay 根路径。不同 origin 的 IndexedDB 不共享，首次使用需要重新配对；不要导出私钥进行迁移。

升级内置 PWA 时，维护者更新 `SPCOD_PWA_REF` 并推送仓库；部署者运行 `git pull && ./deploy.sh`。`STATIC_DIR` 仍可用于本地开发或特殊定制，但不再是默认部署步骤。relay 同源托管 PWA 时也是代码分发源，E2E 还需信任该源；自托管可同时控制 relay 与 PWA 构建。CSP 的 `script-src 'self'` 不允许内联脚本，PWA 主题启动脚本已外置为 `theme-boot.js`。

## 使用其他反向代理

如果不使用内置 Caddy，先运行 `./deploy.sh --no-tls` 完成初始构建，再在 `deploy/relay.env` 设置 `RELAY_BIND=127.0.0.1` 和 `TRUST_PROXY=true`，然后执行 `docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml up -d relay` 应用。后续更新可执行同一 Compose 命令并加 `--build`。无域名时再次运行 `./deploy.sh` 会把这两项分别重置为 `0.0.0.0` 和 `false`，不要用它应用外部反代配置。

代理必须：

- 终止 TLS，并将外部 `wss://<域名>` 转发到 relay；
- 转发 WebSocket 的 `Upgrade` 与 `Connection` 头；
- 设置可信的 `X-Forwarded-For`，然后将 `TRUST_PROXY=true`；否则 `MAX_CONNS_PER_IP` 和票据限流会把所有访客计为同一代理 IP；
- 转发 `/v1/relay-info`、`/v1/tickets`、`/health` 和 channel WebSocket 路径。

最小 Caddy 配置示例：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## 安全与数据说明

- accessKey 只在 v3 host proof / device grant 之上叠加 relay 准入门槛，不是手机或电脑的端到端加密私钥。
- host proof、device grant 和可选 accessKey 用于换取 30 秒单次 ticket；长期凭据不应写入 WebSocket URL。
- relay 使用 `tweetnacl` 的 `box.before` 生成基于 X25519 的 NaCl 预计算共享密钥，再以 HMAC-SHA256 校验 proof 与 grant；这些密钥不用于解密业务帧。
- 不要随意更换 `RELAY_SECRET_KEY`；所有已签发设备 grant 都会失效。被吊销设备的未过期 grant 在签发后最长 7 天内仍可用于新取票/连接，但桌面会拒绝其 auth；relay 也不会按 grant 到期主动断开既有 WS。
- relay 不记录消息明文；离线队列只存在内存中，默认最多保留 72 小时的密文与相关元数据，重启后由客户端重连恢复。
- 定期更新源码并重新部署。更新前可备份 `deploy/relay.env`，不要备份或公开客户端私钥。
