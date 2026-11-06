# Spcod Relay one-command deployment guide

[中文](DEPLOYMENT.md)

This guide starts with a fresh remote Linux server. Deployment does not require GitHub Actions, GHCR, Node.js, or pnpm; the image is built directly from the cloned source.

## 1. Dependencies and network requirements

| Item | Requirement |
|---|---|
| Operating system | Linux with Docker support, x86_64 or arm64 |
| Command line | Bash and Git |
| Containers | Docker Engine 24.0+, Docker Buildx, and the Docker Compose 2.20+ plugin |
| Deployment without a domain | Allow TCP 8787, or expose it only on a private network |
| Deployment with a domain | Point A/AAAA records at the server and allow TCP 80 and 443; UDP 443 is optional for HTTP/3 |

### Check dependencies

```bash
git --version
docker --version
docker compose version
docker info
```

Besides confirming that the commands exist, `docker info` checks that the Docker daemon is running and accessible to the current user.

### Install dependencies on Ubuntu

On Ubuntu 22.04/24.04, use Docker's official apt repository:

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

Verify the installation:

```bash
sudo docker run --rm hello-world
```

To let the current regular user run Docker without `sudo`:

```bash
sudo usermod -aG docker "$USER"
```

Then log out and back in before running `docker info`. For other distributions, use the [official Docker installation guide](https://docs.docker.com/engine/install/). The deployment script does not modify system packages or firewall rules. Check both the cloud security group and host firewall; published Docker ports can bypass some UFW rules, as explained in [Docker's UFW documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

## 2. Deploy with one command

```bash
git clone https://github.com/spcodhu/Spcod-relay.git
cd Spcod-relay
./deploy.sh --check   # Optional: check Git, Docker, Compose, and daemon access
./deploy.sh
```

The script will:

1. Check Git, Docker, and Compose;
2. Create `deploy/relay.env` on the first run, readable and writable only by the current user;
3. Generate a random 32-byte `RELAY_ACCESS_KEY`;
4. Build the `spcod-relay:local` image with both the relay and mobile PWA; the PWA is compiled inside Docker from a pinned Spcod source commit, with no file upload;
5. Start the relay and wait for its `/health` check to pass;
6. Print the relay URL and access key required by harness.

After deployment, verify it manually:

```bash
# JSON health check for command-line use and monitoring
curl --fail http://127.0.0.1:8787/health
# {"ok":true,"version":2}

# Check container status
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml ps
```

You can also open `http://<SERVER_IP>:8787/health` in a browser on another machine. The public health page follows the browser's Chinese or English language preference and shows service status, protocol version, and UTC check time. It contains no access key, connection information, or message content. Command-line `curl` still receives JSON because `/health` selects its response format from the `Accept` request header.

## 3. Configure Spcod harness

Open **Spcod harness → Settings → Remote Control → Self-hosted** and enter:

| Setting | Value |
|---|---|
| Relay URL | `ws://<SERVER_IP>:8787` |
| Access key | The `Access key` printed by the deployment script |

Save and test the connection. Configure the mobile client with the same relay URL and key. Do not share pairing QR codes that contain the access key.

The no-domain mode uses HTTP/WebSocket. Application messages are always end-to-end encrypted, but a long-lived public service should still use HTTPS/WSS as described below to protect connection metadata and ticket exchange.

## 4. Add a domain and automatic HTTPS later

Point the A/AAAA records for `relay.example.com` at the server. Confirm that DNS has propagated and TCP ports 80 and 443 are publicly reachable, then run:

```bash
./deploy.sh --domain relay.example.com
```

This preserves the existing access key and automatically:

- Writes `DOMAIN` to `deploy/relay.env`;
- Starts Caddy 2 to obtain and renew Let's Encrypt/ZeroSSL certificates;
- Binds the relay's host port to `127.0.0.1`;
- Proxies HTTP and WebSocket traffic through Caddy;
- Persists certificates and Caddy configuration in Docker volumes.

Verify the deployment:

```bash
curl --fail https://relay.example.com/health
# {"ok":true,"version":2}
```

Finally, change the harness relay URL to `wss://relay.example.com`. The access key remains unchanged.

If a certificate is not issued, inspect DNS, firewall ports 80/443, and the Caddy logs:

```bash
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls logs --tail=100 caddy
```

### Ports 80/443 are already in use

Identify the processes using the ports:

```bash
sudo ss -ltnp '( sport = :80 )'
sudo ss -ltnp '( sport = :443 )'
```

To make Caddy use different **host ports**, run:

```bash
./deploy.sh --domain relay.example.com --http-port 8080 --https-port 8443
```

You can override just one port, such as `--http-port 8080`. Ports must be between 1 and 65535. Values persist as `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` in `deploy/relay.env`, so later updates do not need the arguments again. Compose maps these host ports to Caddy's internal ports 80/443.

When HTTPS uses a port other than 443, include it in both the health-check and harness URLs:

```text
https://relay.example.com:8443/health
wss://relay.example.com:8443
```

**Certificate caveat**: custom ports are intended for an upstream reverse proxy, port forwarding, or private networks. Public ACME certificate validation still has fixed external connectivity requirements that cannot be bypassed merely by changing Docker ports. If another web service occupies 80/443, configure it to forward ACME validation and WebSocket traffic, or free the standard ports and use the defaults.

## 5. Configuration and updates

### Build cache and acceleration

The first build downloads the Node base image, the pinned Spcod source archive, and mobile dependencies. The Dockerfile separates the base image, source, npm-download cache, and pnpm into distinct layers. Later builds reuse existing layers, while the pnpm store persists across builds through BuildKit cache mounts. The pinned pnpm version is installed directly into an image layer and does not rely on Corepack downloads.

Before building, `deploy.sh` checks `NODE_IMAGE`. It reuses an existing local image and only performs an explicit pull when the image is missing, preventing BuildKit from downloading the base again on every run.

If Docker Hub or npm is slow, add these values to `deploy/relay.env`:

```dotenv
NODE_IMAGE=<your-cloud-mirror>/library/node:22-alpine
NPM_REGISTRY=https://registry.npmmirror.com
```

Then run `./deploy.sh`. For Docker Hub, use the accelerator URL assigned by your cloud provider and merge it into `/etc/docker/daemon.json`:

```json
{
  "registry-mirrors": ["https://<your-dedicated-accelerator>"]
}
```

Then run `sudo systemctl daemon-reload && sudo systemctl restart docker`. If the file already contains other settings, merge the JSON instead of replacing it.

`NODE_IMAGE=node:22-alpine` is still a Docker Hub tag; Docker decides whether it uses the daemon registry mirror. If the mirror is not used or remains slow, change `NODE_IMAGE` to a complete image path in an accessible registry. You can also run `docker pull node:22-alpine` once on the server; subsequent `deploy.sh` runs reuse the local image.

Cache mounts require Docker Buildx. If the log says `buildx isn't installed`, install it on Ubuntu with:

```bash
sudo apt install -y docker-buildx-plugin
```

Preserve the build cache: normal `git pull && ./deploy.sh` runs reuse it, while `docker system prune`, `docker builder prune`, and `docker compose build --no-cache` remove it and force fresh downloads. Use `--no-cache` only when diagnosing a broken build.

The main configuration file is `deploy/relay.env`. It contains the access key, is excluded by `.gitignore`, and must not be committed or published.

After changing configuration, rerun `./deploy.sh` to rebuild and restart. The script reads the saved domain, so updates do not need `--domain` again:

```bash
git pull
./deploy.sh
```

To disable Caddy temporarily and expose port 8787 directly:

```bash
./deploy.sh --no-tls
```

To enable the saved domain again:

```bash
./deploy.sh --domain relay.example.com
```

## 6. Common operations

Run these commands from the project root.

```bash
# Show all service statuses
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls ps

# Follow relay logs
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml logs -f relay

# Restart the relay
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml restart relay

# Stop relay and Caddy while preserving configuration and certificate volumes
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls down
```

The offline queue is memory-only. Clients must reconnect after a restart or update; the relay queue is not a persistent database.

## 7. PWA and cross-origin configuration

The Docker image includes the mobile PWA. No manual build, upload, or volume configuration is required. After deployment, open the relay root URL to pair:

- Without a domain: `http://<SERVER_IP>:8787/`
- With a domain and HTTPS: `https://relay.example.com/`

Later `git pull && ./deploy.sh` runs update both the relay and PWA. The Spcod source commit is pinned by `SPCOD_PWA_REF` in the `Dockerfile`; maintainers update that commit and push the repository to release a newer PWA.

No extra CORS configuration is needed when the mobile PWA and relay use the same origin. For an official or self-hosted PWA on another origin, set the complete origins in `deploy/relay.env`, separated by commas:

```dotenv
CORS_ALLOWED_ORIGINS=https://app.example.com,https://another.example.com
```

Then rerun `./deploy.sh`. Do not include paths or wildcards.

## 8. Troubleshooting

- **Docker is unavailable**: make sure Docker is running and the current user can access its socket.
- **Compose is unavailable**: install the Compose v2 plugin. Use `docker compose`, not the legacy `docker-compose` command.
- **Port 8787 is unreachable remotely**: check the cloud security group, host firewall, and whether the harness URL is `ws://IP:8787`.
- **WSS connection fails**: check `https://DOMAIN/health`, then DNS, ports 80/443, and Caddy logs.
- **The mobile PWA receives `origin_denied`**: add its complete origin to `CORS_ALLOWED_ORIGINS`.
- **The access key is lost**: read `RELAY_ACCESS_KEY` from `deploy/relay.env` on the server and re-enter it in the clients.
- **The deployment health check fails**: inspect the relay with the Compose `logs --tail=100 relay` command.
- **The PWA build stage fails**: verify that the server can reach GitHub and that the pinned Spcod commit exists; do not switch to a local file-upload workflow.

See the [self-hosting guide](SELF_HOSTING.md) for advanced runtime settings.
