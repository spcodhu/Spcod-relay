# Spcod Relay 一键部署教程

[English](DEPLOYMENT.en.md)

本教程面向一台全新的远端 Linux 服务器。整个部署不需要 GitHub Actions、GHCR、Node.js 或 pnpm；镜像直接从当前克隆的源码构建。

## 1. 依赖与网络要求

| 项目 | 要求 |
|---|---|
| 操作系统 | 可运行 Docker 的 Linux，x86_64 或 arm64 |
| 命令行 | Bash、Git |
| 容器 | Docker Engine 24.0+、Docker Buildx、Docker Compose 2.20+ 插件 |
| 无域名部署 | 放行 TCP 8787，或仅在内网开放 |
| 域名部署 | 域名 A/AAAA 记录指向服务器，放行 TCP 80、443；UDP 443 可选，用于 HTTP/3 |

### 检查依赖

```bash
git --version
docker --version
docker compose version
docker info
```

`docker info` 不仅能确认命令存在，还能检查 Docker 守护进程是否运行、当前用户是否有访问权限。

### Ubuntu 安装依赖

Ubuntu 22.04/24.04 可使用 Docker 官方 apt 仓库：

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

验证安装：

```bash
sudo docker run --rm hello-world
```

如需让当前普通用户不使用 `sudo` 运行 Docker：

```bash
sudo usermod -aG docker "$USER"
```

然后注销并重新登录，再运行 `docker info`。其他发行版使用 [Docker 官方安装指南](https://docs.docker.com/engine/install/)。部署脚本不会自动修改系统软件或防火墙。注意云安全组和宿主机防火墙都要检查；Docker 发布端口可能绕过部分 UFW 规则，详见 [Docker 与 UFW 说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

## 2. 一条命令完成初始部署

```bash
git clone https://github.com/spcodhu/Spcod-relay.git
cd Spcod-relay
./deploy.sh --check   # 可选：确认 Git、Docker、Compose 和守护进程权限
./deploy.sh
```

脚本会依次：

1. 检查 Git、Docker 与 Compose；
2. 首次运行时创建 `deploy/relay.env`，权限设为仅当前用户可读写；
3. 首次生成并持久化 32 字节随机 `RELAY_SECRET_KEY` 作为 relay 身份密钥；自托管默认再生成随机 `RELAY_ACCESS_KEY`；
4. 构建包含 relay 与手机 PWA 的 `spcod-relay:local` 镜像；PWA 从固定提交的 Spcod 源码在 Docker 内构建，无需上传文件；
5. 启动 relay 并等待 `/health` 健康检查通过；
6. 输出 harness 所需的 Relay 地址和访问密钥。

`RELAY_SECRET_KEY` 必须由 `deploy.sh` 生成并保存在 `deploy/relay.env`，生产环境缺失时会直接退出。该密钥是 v3 设备 grant 的验证根；换钥会使全部已签发设备 grant 失效，手机需在局域网重连续期或重新扫码。普通更新会保留原密钥。

### 官方公共实例：`--public`

只有官方公共中继维护者使用公共模式；普通自托管部署不要添加该参数。官方实例执行：

```bash
./deploy.sh --domain spcod-relay.hlt.cab --public
```

该参数会把 `RELAY_PUBLIC=true` 持久写入 `deploy/relay.env` 并清空 `RELAY_ACCESS_KEY`，后续 `git pull && ./deploy.sh` 仍保持公共模式。公共模式不要求 accessKey，但不会绕过 v3 准入：host 必须证明 channel 所有权，device 必须持桌面签发的 grant，WebSocket 仍须使用 30 秒单次 ticket。自托管默认在 v3 准入之上叠加 accessKey。

如需恢复自托管默认配置，将 `RELAY_PUBLIC=false` 写入 `deploy/relay.env` 后运行 `./deploy.sh`；accessKey 为空时脚本会自动生成新值。

启动日志显示 `admission=v3 accessKey=on` 或 `admission=v3 accessKey=off`；WebSocket 握手拒绝日志只记录状态、原因、role 和 channelId，不记录 ticket、密钥、准入证明或查询字符串。

部署后可以手工验证：

```bash
# JSON 健康检查，适合命令行和监控
curl --fail http://127.0.0.1:8787/health
# {"ok":true,"version":3}

# 检查容器状态
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml ps
```

也可以从其他机器的浏览器打开 `http://<服务器IP>:8787/health`。浏览器会看到中英文自适应的健康页面，显示运行状态、协议版本和 UTC 检查时间；该页面是公开的，但不包含访问密钥、连接信息或消息内容。命令行 `curl` 仍获得 JSON，因为 `/health` 会根据 `Accept` 请求头自动选择响应格式。

## 3. 配置 Spcod harness

打开 **Spcod harness → 设置 → 远程控制 → 自托管**，填写：

| 配置项 | 值 |
|---|---|
| Relay 地址 | `ws://<服务器IP>:8787` |
| 访问密钥 | 部署脚本输出的 `Access key` |

保存后测试连接。手机端使用同一个 relay 地址和密钥；包含访问密钥的配对二维码不要分享。accessKey 只是叠加的 Bearer 门槛，不能替代 host proof 或桌面签发的 device grant。

无域名模式使用 HTTP/WebSocket。业务消息始终端到端加密，但长期公网服务仍建议使用下文的 HTTPS/WSS，保护连接元数据与票据交换。

## 4. 后续启用域名与自动 HTTPS

先将 `relay.example.com` 的 A/AAAA 记录指向服务器，确认 DNS 已生效且 TCP 80、443 可从公网访问，然后运行：

```bash
./deploy.sh --domain relay.example.com
```

该命令会保留原访问密钥，并自动：

- 将 `DOMAIN` 写入 `deploy/relay.env`；
- 启动 Caddy 2，申请并续期 Let's Encrypt/ZeroSSL 证书；
- 将 relay 的宿主机端口绑定到 `127.0.0.1`；
- 通过 Caddy 转发 HTTP 与 WebSocket，并设置 `TRUST_PROXY=true` 以按真实客户端 IP 执行限额；
- 将证书和 Caddy 配置保存到 Docker 数据卷。

`MAX_CONNS_PER_IP` 默认限制每 IP 64 条并发 WebSocket。使用其他前置反代时，必须设置可信的 `X-Forwarded-For` 和 `TRUST_PROXY=true`，否则所有访客会共享代理 IP 的限额；配置方法见[自托管指南](SELF_HOSTING.md#使用其他反向代理)。

验证：

```bash
curl --fail https://relay.example.com/health
# {"ok":true,"version":3}
```

最后将 harness 的 Relay 地址改为 `wss://relay.example.com`。访问密钥无需改变。

如果证书尚未签发，请检查 DNS、80/443 防火墙和 Caddy 日志：

```bash
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls logs --tail=100 caddy
```

### 80/443 端口被占用

先检查是哪个进程占用端口：

```bash
sudo ss -ltnp '( sport = :80 )'
sudo ss -ltnp '( sport = :443 )'
```

如果需要让 Caddy 使用其他**宿主机端口**，运行：

```bash
./deploy.sh --domain relay.example.com --http-port 8080 --https-port 8443
```

也支持只覆盖一个端口，例如 `--http-port 8080`。端口必须在 1～65535 之间，设置会写入 `deploy/relay.env` 的 `CADDY_HTTP_PORT` 和 `CADDY_HTTPS_PORT`，后续更新无需重复传入。Compose 会把宿主机端口映射到 Caddy 容器内部的 80/443。

HTTPS 使用非 443 端口时，验证地址和 harness 地址都要带端口：

```text
https://relay.example.com:8443/health
wss://relay.example.com:8443
```

**证书注意事项**：自定义端口适合已有外层反向代理、端口映射或私有网络的场景。公网 ACME 证书验证仍有固定的外部连接要求，不能仅靠修改 Docker 端口绕过。如果 80/443 已被其他 Web 服务占用，推荐配置现有服务转发 ACME 验证和 WebSocket，或释放标准端口后使用默认配置。

## 5. 配置与更新

### 构建缓存与加速

首次构建会下载 Node 基础镜像、固定提交的 Spcod 源码和手机端依赖。Dockerfile 已将基础镜像、源码、npm 下载缓存与 pnpm 分成独立层；后续更新会复用已有镜像层，pnpm store 通过 BuildKit cache mount 跨构建保留。pnpm 固定版本直接安装进镜像层，不依赖 Corepack 临时下载。

`deploy.sh` 在构建前会检查 `NODE_IMAGE`：本地已有该镜像时直接复用；本地缺失时才显式预拉一次，避免 BuildKit 每次重新下载。

如果 Docker Hub 或 npm 较慢，可在 `deploy/relay.env` 中增加：

```dotenv
NODE_IMAGE=<云厂商镜像地址>/library/node:22-alpine
NPM_REGISTRY=https://registry.npmmirror.com
```

再执行 `./deploy.sh`。Docker Hub 加速建议使用云厂商控制台分配的专属地址，并合并写入 `/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://<你的专属加速地址>"]
}
```

修改后执行 `sudo systemctl daemon-reload && sudo systemctl restart docker`。如果文件已有其他配置，请合并 JSON，不要直接覆盖。

`NODE_IMAGE=node:22-alpine` 仍然是 Docker Hub 标签，是否经过 daemon 镜像加速器由 Docker 决定。如果加速器没有命中或比较慢，应把 `NODE_IMAGE` 改成镜像仓库中的完整路径；也可以先在服务器执行 `docker pull node:22-alpine` 完成一次下载，之后 `deploy.sh` 会直接复用本地镜像。

缓存挂载需要 Docker Buildx。日志出现 `buildx isn't installed` 时，Ubuntu 可执行：

```bash
sudo apt install -y docker-buildx-plugin
```

保留构建缓存很重要：正常执行 `git pull && ./deploy.sh` 会复用缓存；`docker system prune`、`docker builder prune`、`docker compose build --no-cache` 会删除缓存并导致重新下载。只有缓存损坏或排查构建问题时才使用 `--no-cache`。

主要配置文件是 `deploy/relay.env`。它包含 relay 身份密钥和访问密钥，已被 `.gitignore` 排除，不要提交或公开。

修改配置后，重新运行 `./deploy.sh` 即可重建并重启。脚本会读取已保存的域名、密钥和公共模式，因此更新时不必重复传入 `--domain` 或 `--public`：

```bash
git pull
./deploy.sh
```

如需临时关闭 Caddy 并重新直接暴露 8787：

```bash
./deploy.sh --no-tls
```

再次启用已保存的域名：

```bash
./deploy.sh --domain relay.example.com
```

## 6. 常用运维命令

以下命令均在项目根目录执行。

```bash
# 查看全部服务状态
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls ps

# 跟踪 relay 日志
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml logs -f relay

# 重启 relay
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml restart relay

# 停止 relay 与 Caddy，但保留配置和证书数据卷
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls down
```

离线消息队列只在内存中，默认最多保留 72 小时的密文与相关元数据。重启或更新后客户端需要重连，不要把 relay 队列当作持久化数据库。

## 7. PWA 与跨域配置

Docker 镜像已内置手机 PWA，无需手工构建、上传或配置 volume。部署完成后直接打开 relay 根路径即可配对：

- 无域名：`http://<服务器IP>:8787/`
- 域名与 HTTPS：`https://relay.example.com/`

后续 `git pull && ./deploy.sh` 会同时更新 relay 与 PWA。PWA 源码提交由 `Dockerfile` 的 `SPCOD_PWA_REF` 固定，维护者升级该提交后推送仓库即可。relay 同源分发 PWA 时也是代码分发源，E2E 不能替代对该源的信任；自托管可同时控制 relay 与 PWA 构建。响应 CSP 使用 `script-src 'self'`，主题启动脚本已外置为 `theme-boot.js`。

如果手机端 PWA 与 relay 使用同一个域名和端口，无需额外配置 CORS。若使用其他域名下的官方或自托管 PWA，在 `deploy/relay.env` 中设置完整 origin，多个值用英文逗号分隔：

```dotenv
CORS_ALLOWED_ORIGINS=https://app.example.com,https://another.example.com
```

然后重新运行 `./deploy.sh`。不要填写路径或通配符。

## 8. 故障排查

- **提示 Docker 不可用**：确认 Docker 已启动，当前用户有权限访问 Docker socket。
- **提示 Compose 不可用**：安装 Compose v2 插件；命令是 `docker compose`，不是旧版 `docker-compose`。
- **远程无法连接 8787**：检查云安全组、本机防火墙和 harness 地址是否为 `ws://IP:8787`。
- **WSS 连接失败**：先检查 `https://域名/health`，再检查 DNS、80/443 和 Caddy 日志。
- **手机 PWA 返回 `origin_denied`**：把 PWA 的完整 origin 加入 `CORS_ALLOWED_ORIGINS`。
- **密钥遗失**：在服务器上查看 `deploy/relay.env` 的 `RELAY_ACCESS_KEY`，然后重新填写到客户端。
- **生产环境提示缺少 `RELAY_SECRET_KEY`**：运行 `./deploy.sh` 生成并持久化身份密钥，不要手工改为临时密钥。
- **更换 relay 身份密钥后设备无法连接**：原设备 grant 已失效；在局域网重连续期或重新扫码。
- **部署健康检查失败**：运行 Compose 的 `logs --tail=100 relay` 查看日志。
- **PWA 构建阶段失败**：确认服务器能访问 GitHub，并检查 Dockerfile 中固定的 Spcod 提交是否存在；无需改为本机上传文件。

更多运行参数见[自托管指南](SELF_HOSTING.md)。
