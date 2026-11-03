# Spcod Relay — Zero-knowledge dumb relay

[中文](README.md) · [Deployment guide](docs/DEPLOYMENT.en.md) · [Self-hosting configuration](docs/SELF_HOSTING.md) · [Protocol](docs/PROTOCOL.md) · [Privacy](docs/PRIVACY.md)

A self-hosted relay for Spcod harness remote control. It routes end-to-end encrypted data between phones and computers without reading code, prompts, conversations, or scheduled-task content.

## One-command deployment

On a remote Linux server with **Docker 24+ and the Docker Compose v2 plugin**, run:

```bash
git clone https://github.com/spcodhu/Spcod-relay.git
cd Spcod-relay
./deploy.sh
```

The script generates the local configuration and a random access key, builds an image from the checked-out source, starts the service, and waits for its health check. Node.js, pnpm, and manual configuration are not required.

When deployment finishes, the terminal prints the relay URL and access key. In **Spcod harness → Settings → Remote Control → Self-hosted**, enter:

- Relay URL: `ws://<SERVER_IP>:8787`
- Access key: the printed `Access key`

Configuration and credentials are stored in `deploy/relay.env`, which is ignored by Git. Direct HTTP/WebSocket is intended for temporary or private-network use; enable a domain and HTTPS for a long-lived public deployment.

## Add a domain and automatic TLS later

1. Point the domain's A/AAAA records at the server and allow TCP ports 80 and 443.
2. Run one command:

```bash
./deploy.sh --domain relay.example.com
```

The script starts Caddy, which automatically obtains and renews the TLS certificate. It also restricts the relay port to loopback and proxies WebSocket traffic through Caddy. Certificates persist in Docker volumes.

Then change the relay URL in harness to `wss://relay.example.com`; the access key remains unchanged. See the [deployment guide](docs/DEPLOYMENT.en.md) for details.

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
3. **Optionally hosts the PWA**: place mobile build artifacts in `STATIC_DIR` to serve them from the relay.
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

## License

[MIT](LICENSE)
