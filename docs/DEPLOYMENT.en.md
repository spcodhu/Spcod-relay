# Spcod Relay one-command deployment guide

[中文](DEPLOYMENT.md)

This guide starts with a fresh remote Linux server. Deployment does not require GitHub Actions, GHCR, Node.js, or pnpm; the image is built directly from the cloned source.

## 1. Dependencies and network requirements

| Item | Requirement |
|---|---|
| Operating system | Linux with Docker support, x86_64 or arm64 |
| Command line | Bash and Git |
| Containers | Docker Engine 24.0+ with the Docker Compose 2.20+ plugin |
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
4. Build the `spcod-relay:local` image from the checked-out source;
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

## 5. Configuration and updates

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

See the [self-hosting guide](SELF_HOSTING.md) for advanced runtime settings.
