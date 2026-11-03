#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${ROOT_DIR}/deploy"
ENV_FILE="${DEPLOY_DIR}/relay.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"

usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh                         Deploy relay with HTTP/WebSocket on port 8787
  ./deploy.sh --check                 Check Git, Docker, Compose, and daemon access
  ./deploy.sh --domain relay.example.com
                                      Deploy relay and Caddy with automatic HTTPS
  ./deploy.sh --no-tls                Disable Caddy and expose relay directly

Requires Git, Docker 24+, and the Docker Compose v2 plugin.
Configuration and the generated access key are stored in deploy/relay.env.
EOF
}

log() {
  printf '[spcod-relay] %s\n' "$*"
}

die() {
  printf '[spcod-relay] ERROR: %s\n' "$*" >&2
  exit 1
}

mode="auto"
domain_override=""
check_only=false
while (($# > 0)); do
  case "$1" in
    --check)
      check_only=true
      shift
      ;;
    --domain)
      (($# >= 2)) || die "--domain requires a DNS name."
      mode="domain"
      domain_override="$2"
      shift 2
      ;;
    --domain=*)
      mode="domain"
      domain_override="${1#*=}"
      shift
      ;;
    --no-tls)
      mode="off"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1. Run ./deploy.sh --help for usage."
      ;;
  esac
done

command -v git >/dev/null 2>&1 || die "Git is required. Install Git first."
command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker 24+ and the Compose v2 plugin first."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)."
docker info >/dev/null 2>&1 || die "Docker is not running or the current user cannot access it. Start Docker or check your permissions."

if [[ "${check_only}" == true ]]; then
  log "$(git --version)"
  log "$(docker --version)"
  log "$(docker compose version)"
  log "Docker daemon is running and accessible."
  log "All deployment dependencies are available."
  exit 0
fi

[[ -f "${DEPLOY_DIR}/relay.env.example" ]] || die "Missing deploy/relay.env.example."
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${DEPLOY_DIR}/relay.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Created deploy/relay.env."
fi

get_env() {
  local key="$1"
  awk -v key="${key}" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "${ENV_FILE}"
}

set_env() {
  local key="$1"
  local value="$2"
  local temp_file="${ENV_FILE}.tmp"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { written = 0 }
    index($0, key "=") == 1 {
      if (!written) print key "=" value
      written = 1
      next
    }
    { print }
    END { if (!written) print key "=" value }
  ' "${ENV_FILE}" > "${temp_file}"
  mv "${temp_file}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
}

generate_access_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

access_key="$(get_env RELAY_ACCESS_KEY)"
if [[ -z "${access_key}" || "${access_key}" == replace-with-* ]]; then
  access_key="$(generate_access_key)"
  set_env RELAY_ACCESS_KEY "${access_key}"
  log "Generated a new RELAY_ACCESS_KEY."
fi

case "${mode}" in
  domain) domain="${domain_override}" ;;
  off) domain="" ;;
  auto) domain="$(get_env DOMAIN)" ;;
esac

if [[ -n "${domain}" ]]; then
  if [[ ! "${domain}" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
    die "DOMAIN must be a DNS name such as relay.example.com, without a scheme or path."
  fi
  set_env DOMAIN "${domain}"
  set_env RELAY_BIND 127.0.0.1
  set_env TRUST_PROXY true
else
  set_env DOMAIN ""
  set_env RELAY_BIND 0.0.0.0
  set_env TRUST_PROXY false
fi

relay_port="$(get_env RELAY_PORT)"
relay_port="${relay_port:-8787}"
compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

if [[ -n "${domain}" ]]; then
  log "Building relay and starting Caddy with automatic HTTPS for ${domain}..."
  "${compose[@]}" --profile tls up -d --build --remove-orphans
else
  log "Building and starting relay on port ${relay_port}..."
  "${compose[@]}" up -d --build --remove-orphans relay
fi

log "Waiting for the relay health check..."
healthy=false
for ((attempt = 1; attempt <= 30; attempt++)); do
  if "${compose[@]}" exec -T relay wget -qO- http://127.0.0.1:8787/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "${healthy}" != true ]]; then
  "${compose[@]}" logs --tail=50 relay >&2 || true
  die "Relay did not become healthy. Check the logs above."
fi

if [[ -n "${domain}" ]]; then
  if ! "${compose[@]}" --profile tls ps --status running --services | awk '$0 == "caddy" { found = 1 } END { exit !found }'; then
    "${compose[@]}" --profile tls logs --tail=50 caddy >&2 || true
    die "Caddy is not running. Check DNS, firewall ports 80/443, and the logs above."
  fi
  relay_url="wss://${domain}"
  health_url="https://${domain}/health"
else
  relay_url="ws://<SERVER_IP>:${relay_port}"
  health_url="http://<SERVER_IP>:${relay_port}/health"
fi

cat <<EOF

Deployment completed successfully.

Spcod harness settings -> Remote Control -> Self-hosted:
  Relay URL:   ${relay_url}
  Access key:  ${access_key}

Health check: ${health_url}
Configuration: ${ENV_FILE}

EOF

if [[ -z "${domain}" ]]; then
  printf 'To enable a domain and automatic HTTPS later, run: ./deploy.sh --domain relay.example.com\n'
else
  printf 'Caddy will obtain and renew the TLS certificate automatically. DNS and ports 80/443 must be reachable.\n'
fi
