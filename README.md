# Spcod Relay —— 零知识哑中继

[English](README.en.md) · [一键部署教程](docs/DEPLOYMENT.md) · [自托管配置](docs/SELF_HOSTING.md) · [协议](docs/PROTOCOL.md) · [隐私](docs/PRIVACY.md)

Spcod harness 远程控制功能的自托管中继服务器。它只在手机与电脑之间路由端到端加密的数据，不解析代码、提示词、会话或定时任务内容。

## 一键部署

在已安装 **Docker 24+ 和 Docker Compose v2 插件**的远端 Linux 服务器上执行：

```bash
git clone https://github.com/spcodhu/Spcod-relay.git
cd Spcod-relay
./deploy.sh
```

脚本会自动完成：生成本地配置文件和随机访问密钥、从当前源码构建镜像、启动服务并等待健康检查。无需安装 Node.js、pnpm，也无需手工复制或编辑配置。

部署完成后，终端会显示 Relay 地址和访问密钥。在 **Spcod harness → 设置 → 远程控制 → 自托管**中填写：

- Relay 地址：`ws://<服务器IP>:8787`
- 访问密钥：终端输出的 `Access key`

配置与密钥保存在 `deploy/relay.env`，该文件已被 Git 忽略。直接暴露的 HTTP/WebSocket 适合临时或内网使用；长期公网部署建议按下一步启用域名和 HTTPS。

## 后续配置域名与自动证书

1. 将域名的 A/AAAA 记录指向服务器，并放行 TCP 80、443。
2. 执行一条命令：

```bash
./deploy.sh --domain relay.example.com
```

脚本会启动 Caddy，自动申请和续期 TLS 证书，将 relay 收回本机回环地址，并通过反向代理转发 WebSocket。证书保存在 Docker 数据卷中。

随后把 harness 中的 Relay 地址改为 `wss://relay.example.com`，访问密钥不变。完整教程见[部署指南](docs/DEPLOYMENT.md)。

## 依赖版本

| 用途 | 依赖 |
|---|---|
| 一键部署 | Bash、Git、Docker Engine 24.0+、Docker Compose 2.20+（`docker compose`） |
| 域名与证书 | Caddy 2（由 Compose 自动运行，无需单独安装） |
| 本地开发 | Node.js 22.19+、pnpm 9.15.9 |

Docker 镜像使用 Node.js 22 Alpine，并在构建阶段锁定 pnpm 9.15.9。部署脚本会检查 Docker 与 Compose 是否可用。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

服务默认监听 `8787` 端口；健康检查为：

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"version":2}
```

## 工作原理

1. **按 channel 路由密文**：channel 标识是桌面端公钥的 SHA-256 哈希，业务帧原样转发。
2. **离线消息队列**：对方不在线时按 channel 分方向缓存密文，上线后按序补投；队列仅在内存中，重启后由客户端重连恢复。
3. **可选托管 PWA**：将手机端构建产物放入 `STATIC_DIR` 即可通过 relay 提供静态页面。
4. **准入保护**：自托管实例默认生成访问密钥；客户端用长期密钥换取 30 秒单次 ticket，再通过 WebSocket 连接。

relay 没有账号体系，不记录消息明文，也不把离线队列持久化到磁盘。

## 常用运维命令

```bash
# 查看运行状态
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls ps

# 查看 relay 日志
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml logs -f relay

# 拉取更新并重新部署（保留现有配置和密钥）
git pull
./deploy.sh

# 停止全部服务
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls down
```

更多环境变量、PWA origin 和反向代理配置见[自托管指南](docs/SELF_HOSTING.md)。

## 许可

[MIT](LICENSE)
