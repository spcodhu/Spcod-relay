# Spcod Relay — Zero-knowledge dumb relay

[中文](README.md) · [Deployment guide](docs/DEPLOYMENT.en.md) · [Self-hosting configuration](docs/SELF_HOSTING.md) · [Protocol](docs/PROTOCOL.md) · [Privacy](docs/PRIVACY.md)

A self-hosted relay for Spcod harness remote control. It routes end-to-end encrypted data between phones and computers without reading code, prompts, conversations, or scheduled-task content.

## Check and install dependencies

Deployment only requires Bash, Git, Docker Engine 24+, and the Docker Compose 2.20+ plugin. Check them first:

```bash
git --version
docker --version
docker compose version
docker info
```

On Ubuntu 22.04/24.04, install all dependencies from Docker's official apt repository:

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

Run `sudo docker run --rm hello-world` to verify the installation. To let a regular user run Docker directly, run `sudo usermod -aG docker "$USER"`, then log out and back in. For other distributions, use the [official Docker installation guide](https://docs.docker.com/engine/install/).

## One-command deployment

```bash
git clone https://github.com/spcodhu/Spcod-relay.git
cd Spcod-relay
./deploy.sh --check   # Optional: show versions and check Docker daemon access
./deploy.sh
```

The script generates the local configuration and a random access key, builds **one image containing both the relay and mobile PWA**, starts the service, and waits for its health check. The PWA is built during the Docker build from a pinned Spcod source commit. Node.js, pnpm, file uploads, and manual Compose edits are not required.

When deployment finishes, the terminal prints the relay URL and access key. In **Spcod harness → Settings → Remote Control → Self-hosted**, enter:

- Relay URL: `ws://<SERVER_IP>:8787`
- Access key: the printed `Access key`

Configuration and credentials are stored in `deploy/relay.env`, which is ignored by Git. Direct HTTP/WebSocket is intended for temporary or private-network use; enable a domain and HTTPS for a long-lived public deployment.

## Verify installation and deployment

- **Browser health page**: open `http://<SERVER_IP>:8787/health`, or `https://relay.example.com/health` after configuring a domain. It follows the browser's Chinese or English language preference and only shows service status, protocol version, and check time—never credentials or message data.
- **Command line and automation**: run `curl --fail http://<SERVER_IP>:8787/health`, replacing the URL with `https://relay.example.com/health` after configuring a domain. A healthy service returns `{"ok":true,"version":2}`.
- **Container status**: run `docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls ps`. The relay should be `healthy`; Caddy should be `running` when a domain is enabled.

`/health` uses the `Accept` request header to serve HTML to browsers and JSON to automation, so both use the same endpoint.

The mobile pairing page ships in the same image. Open `http://<SERVER_IP>:8787/`, or `https://relay.example.com/` after configuring a domain. The deployment script checks both relay health and the embedded PWA; the root URL should display the Spcod pairing page.

## Add a domain and automatic TLS later

1. Point the domain's A/AAAA records at the server and allow TCP ports 80 and 443.
2. Run one command:

```bash
./deploy.sh --domain relay.example.com
```

The script starts Caddy, which automatically obtains and renews the TLS certificate. It also restricts the relay port to loopback and proxies WebSocket traffic through Caddy. Certificates persist in Docker volumes.

Then change the relay URL in harness to `wss://relay.example.com`; the access key remains unchanged. See the [deployment guide](docs/DEPLOYMENT.en.md) for details.

### Ports 80/443 are already in use

The defaults remain 80/443 because they are simplest for direct public Caddy certificate issuance. To override the host ports:

```bash
./deploy.sh --domain relay.example.com --http-port 8080 --https-port 8443
```

The values persist in `deploy/relay.env`, so later `./deploy.sh` runs reuse them. With a non-standard HTTPS port, the harness URL and health page become `wss://relay.example.com:8443` and `https://relay.example.com:8443/health`.

These options only change Docker host-port mappings; Caddy still uses 80/443 inside the container. **Public certificate issuance still requires a working ACME validation path.** If Nginx or another service occupies 80/443, configure the existing reverse proxy and certificate forwarding, or free the standard ports—changing ports alone does not guarantee certificate issuance.

## Dependency versions

| Use case | Dependencies |
|---|---|
| One-command deployment | Bash, Git, Docker Engine 24.0+, Docker Compose 2.20+ (`docker compose`) |
| Domain and TLS | Caddy 2 (started automatically by Compose; no separate installation) |
| Local development | Node.js 22.19+, pnpm 9.15.9 |

The Docker image uses Node.js 22 Alpine and pins pnpm 9.15.9 during the build. The deployment script checks that Docker and Compose are available.

## Local development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

The server listens on port `8787` by default. Check its health with:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"version":2}
```

## How it works

1. **Routes ciphertext by channel**: the channel ID is the SHA-256 hash of the desktop public key; application frames are forwarded unchanged.
2. **Queues offline messages**: ciphertext is queued by channel and direction while a peer is offline, then delivered in order. The queue is memory-only; clients reconnect and recover after a restart.
3. **Includes the mobile PWA**: the Docker build compiles the PWA from a pinned Spcod source commit and places it in `/app/public` in the final image, serving the relay and pairing page through the same entry point.
4. **Controls access**: self-hosted deployments generate an access key by default. Clients exchange it for a 30-second, single-use ticket before opening a WebSocket.

The relay has no account system, does not log message plaintext, and never persists the offline queue to disk.

## Common operations

```bash
# Show service status
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls ps

# Follow relay logs
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml logs -f relay

# Update and redeploy while preserving configuration and credentials
git pull
./deploy.sh

# Stop all services
docker compose --env-file deploy/relay.env -f deploy/docker-compose.yml --profile tls down
```

See the [self-hosting guide](docs/SELF_HOSTING.md) for environment variables, PWA origins, and reverse-proxy configuration.

To upgrade the embedded PWA, maintainers update the Spcod commit in `ARG SPCOD_PWA_REF` in the `Dockerfile` and push this repository. Official and self-hosted relays then receive the same version through `git pull && ./deploy.sh`; there is no separate upload workflow.

## License

[MIT](LICENSE)
