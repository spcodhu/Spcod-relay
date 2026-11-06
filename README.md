# Spcod Relay —— 零知识哑中继

[English](README.en.md) · [一键部署教程](docs/DEPLOYMENT.md) · [自托管配置](docs/SELF_HOSTING.md) · [协议](docs/PROTOCOL.md) · [隐私](docs/PRIVACY.md)

Spcod harness 远程控制功能的自托管中继服务器。它只在手机与电脑之间路由端到端加密的数据，不解析代码、提示词、会话或定时任务内容。

## 检查与安装依赖

部署只需要 Bash、Git、Docker Engine 24+、Docker Buildx 和 Docker Compose 2.20+ 插件。先检查：

```bash
git --version
docker --version
docker compose version
docker info
```

Ubuntu 22.04/24.04 可使用 Docker 官方 apt 仓库安装全部依赖：

```bash
sudo apt update
sudo apt install -y git ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

安装后可运行 `sudo docker run --rm hello-world` 验证 Docker。如果希望当前普通用户直接运行 Docker，可执行 `sudo usermod -aG docker "$USER"`，然后注销并重新登录。其他发行版请使用 [Docker 官方安装指南](https://docs.docker.com/engine/install/)。

## 一键部署

```bash
git clone https://github.com/spcodhu/Spcod-relay.git
cd Spcod-relay
./deploy.sh --check   # 可选：显示依赖版本并检查 Docker 守护进程
./deploy.sh
```

脚本会自动完成：生成本地配置文件和随机访问密钥、构建**同时包含 relay 与手机 PWA** 的镜像、启动服务并等待健康检查。PWA 在 Docker 构建阶段从固定提交的 Spcod 源码生成，无需安装 Node.js、pnpm，也无需上传文件或手工编辑 Compose。

部署完成后，终端会显示 Relay 地址和访问密钥。在 **Spcod harness → 设置 → 远程控制 → 自托管**中填写：

- Relay 地址：`ws://<服务器IP>:8787`
- 访问密钥：终端输出的 `Access key`

配置与密钥保存在 `deploy/relay.env`，该文件已被 Git 忽略。直接暴露的 HTTP/WebSocket 适合临时或内网使用；长期公网部署建议按下一步启用域名和 HTTPS。

官方公共实例由维护者使用 `./deploy.sh --domain spcod-relay.hlt.cab --anonymous` 部署。该模式持久保存且无需访问密钥；普通自托管不要开启，恢复准入保护使用 `--access-key`。

## 验证安装与部署

- **浏览器健康页**：打开 `http://<服务器IP>:8787/health`；配置域名后打开 `https://relay.example.com/health`。页面会根据浏览器语言显示中文或英文，只包含运行状态、协议版本和检查时间，不包含密钥或消息数据。
- **命令行与自动化**：运行 `curl --fail http://<服务器IP>:8787/health`，配置域名后替换为 `https://relay.example.com/health`。成功时返回 `{"ok":true,"version":2}`。
- **容器状态**：运行 `docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls ps`，确认 relay 为 `healthy`；启用域名后 Caddy 应为 `running`。

`/health` 会按请求头的 `Accept` 自动区分浏览器 HTML 与 JSON，无需维护两个检查地址。

手机配对页也随镜像一起部署：打开 `http://<服务器IP>:8787/`，配置域名后打开 `https://relay.example.com/`。部署脚本会同时检查 relay 健康状态与内置 PWA，根路径应显示 Spcod 配对页。

## 后续配置域名与自动证书

1. 将域名的 A/AAAA 记录指向服务器，并放行 TCP 80、443。
2. 执行一条命令：

```bash
./deploy.sh --domain relay.example.com
```

脚本会启动 Caddy，自动申请和续期 TLS 证书，将 relay 收回本机回环地址，并通过反向代理转发 WebSocket。证书保存在 Docker 数据卷中。

随后把 harness 中的 Relay 地址改为 `wss://relay.example.com`，访问密钥不变。完整教程见[部署指南](docs/DEPLOYMENT.md)。

### 80/443 端口被占用

默认保留 80/443，因为直接使用公网 Caddy 自动证书时最省事。需要自定义宿主机端口时：

```bash
./deploy.sh --domain relay.example.com --http-port 8080 --https-port 8443
```

参数会保存到 `deploy/relay.env`，后续直接运行 `./deploy.sh` 仍沿用该配置。非标准 HTTPS 端口下，harness 地址和健康页分别为 `wss://relay.example.com:8443`、`https://relay.example.com:8443/health`。

自定义端口只改变 Docker 宿主机映射，容器内部仍是 80/443。**公网直接签发证书仍需要有效的 ACME 验证链路**；如果 80/443 已被 Nginx 等服务占用，应配置现有反代和证书转发，或释放标准端口，不能只改端口就假设证书一定可以签发。

## 依赖版本

| 用途 | 依赖 |
|---|---|
| 一键部署 | Bash、Git、Docker Engine 24.0+、Docker Buildx、Docker Compose 2.20+（`docker compose`） |
| 域名与证书 | Caddy 2（由 Compose 自动运行，无需单独安装） |
| 本地开发 | Node.js 22.19+、pnpm 9.15.9 |

Docker 镜像使用 Node.js 22 Alpine，并在构建阶段锁定 pnpm 9.15.9。部署脚本会检查 Docker 与 Compose 是否可用。

## 构建缓存与镜像加速

新 Dockerfile 在首次构建时会下载 Node 基础镜像、固定版本的 Spcod 源码和手机端依赖。之后会分别复用基础镜像层、源码层、npm 下载缓存与 pnpm store；更新 PWA 版本时不会重新下载已经存在的包。固定版本的 pnpm 会通过 npm 安装进镜像层，不再依赖 Corepack 在后续阶段临时下载。

`deploy.sh` 构建前会检查 `NODE_IMAGE`：本地已有该镜像时直接复用，不会再次拉取；本地缺失时才显式执行一次 `docker pull`。

如果服务器访问 Docker Hub 或 npm 较慢，可在 `deploy/relay.env` 中覆盖：

```dotenv
NODE_IMAGE=<云厂商镜像加速地址>/library/node:22-alpine
NPM_REGISTRY=https://registry.npmmirror.com
```

然后重新运行 `./deploy.sh`。`NODE_IMAGE` 也可以直接使用服务器上已经构建或导入的 Node 22 Alpine 镜像。Docker Hub 的加速地址请使用自己云厂商控制台提供的专属镜像加速器；配置 Docker daemon 的 `registry-mirrors` 后，基础镜像下载也会走同一通道。

需要注意：`NODE_IMAGE=node:22-alpine` 仍然是 Docker Hub 标签，是否命中 daemon 镜像加速器由 Docker 决定。如果镜像加速器不稳定，应把 `NODE_IMAGE` 改为一个完整的、可直接访问的镜像仓库路径，例如云厂商镜像仓库中的 `.../library/node:22-alpine`。

构建缓存依赖 Buildx。如果日志提示 `buildx isn't installed`，Ubuntu 可安装：

```bash
sudo apt install -y docker-buildx-plugin
```

首次构建后不要为了“清理”执行 `docker system prune`、`docker builder prune` 或带 `--no-cache` 的重建，否则 BuildKit 的 npm/pnpm 缓存会被删除。正常执行 `git pull && ./deploy.sh` 会优先复用缓存。

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
3. **内置手机 PWA**：Docker 构建阶段从固定提交的 Spcod 源码构建 PWA，并放入最终镜像的 `/app/public`；relay 与配对页通过同一入口提供。
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

维护者需要升级内置 PWA 时，只需更新 `Dockerfile` 中 `ARG SPCOD_PWA_REF` 对应的 Spcod 提交并推送本仓库。官方中继与自托管用户随后都通过 `git pull && ./deploy.sh` 获得同一版本，不产生另一套上传流程。

## 许可

[MIT](LICENSE)
