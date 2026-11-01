# 官方实例部署与回滚

## 初始准备

1. 新建 `spcodhu/spcod-relay` 仓库，开启 GHCR 包读写与 Actions。
2. 准备 Ubuntu VPS、Docker、Caddy 和域名 DNS。
3. 将 `deploy/` 放到 VPS 固定目录，例如 `/opt/spcod-relay`。
4. 配置 `relay.env`：域名、访问密钥、PWA origin、生产限额。
5. 在 GitHub secrets 配置：
   - `DEPLOY_ENABLED=true`（只有明确启用时才部署）
   - `SSH_HOST`、`SSH_USER`、`SSH_KEY`
   - `DEPLOY_HOST_DIR=/opt/spcod-relay`
   - `DEPLOY_HEALTH_URL=https://<domain>/health`
   - 若发布 npm 包：`NPM_TOKEN`

## 首次启动

```bash
cd /opt/spcod-relay
docker compose --env-file relay.env -f docker-compose.yml pull
docker compose --env-file relay.env -f docker-compose.yml up -d
curl http://127.0.0.1:8787/health
```

然后接入 Caddy 并验证 `https://<domain>/health`、PWA 和真实 WSS。

## 发布

tag `v*` 触发：测试 → 多架构 GHCR →（可选）npm → 部署。部署仅在 `DEPLOY_ENABLED=true` 时执行，使用固定 tag，不使用浮动 latest。

上线顺序：先发布兼容旧客户端的 relay，再发布桌面/手机，最后更新 relay 镜像中锁定的 PWA 版本。

## 回滚

```bash
cd /opt/spcod-relay
# 将 relay.env 的 RELAY_VERSION 改为上一稳定 tag
docker compose --env-file relay.env -f docker-compose.yml pull
docker compose --env-file relay.env -f docker-compose.yml up -d
curl --fail https://<domain>/health
```

离线队列只在内存中，回滚/重启后让客户端重连，由桌面对账恢复，不把队列当数据库。

## 监控

- 容器 healthcheck 与 restart policy；
- Caddy TLS 与 WSS 连接成功率；
- relay 错误码、限流、channel/队列/内存配额；
- 不采集业务帧、访问密钥或 ticket。
