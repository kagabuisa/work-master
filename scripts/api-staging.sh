#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
action="${1:-up}"
case "$action" in up|check|status|down) ;; *) echo 'Usage: bash scripts/api-staging.sh up|check|status|down' >&2; exit 1 ;; esac
state_dir="$PWD/data/api-staging"
mkdir -p "$state_dir/tls"
chmod 700 "$state_dir" "$state_dir/tls"
exec 9>"$state_dir/operation.lock"
flock -n 9 || { echo 'Another staging operation is active; wait for it to finish.' >&2; exit 1; }
if [[ ! -f "$state_dir/staging.env" ]]; then
  stage_port="${STAGING_HTTPS_PORT:-3443}"
  if [[ ! "$stage_port" =~ ^[0-9]+$ ]] || (( stage_port < 1024 || stage_port > 65535 )); then echo 'Staging port must be 1024–65535.' >&2; exit 1; fi
  {
    printf 'STAGING_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'STAGING_UID=%s\nSTAGING_GID=%s\nSTAGING_HTTPS_PORT=%s\n' "$(id -u)" "$(id -g)" "$stage_port"
  } > "$state_dir/staging.env"
fi
compose() { docker compose --project-name wm-api-staging --env-file "$state_dir/staging.env" -f docker-compose.staging.yml "$@"; }
case "$action" in
  up)
    if [[ ! -f "$state_dir/tls/ca.crt" ]]; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj '/CN=Work Master Local Staging CA' \
        -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
        -keyout "$state_dir/tls/ca.key" -out "$state_dir/tls/ca.crt" 2>/dev/null
    fi
    if [[ ! -f "$state_dir/tls/server.crt" ]] || ! openssl x509 -checkend 86400 -noout -in "$state_dir/tls/server.crt" >/dev/null; then
      openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$state_dir/tls/server.key" -out "$state_dir/tls/server.csr" 2>/dev/null
      printf 'subjectAltName=DNS:localhost,DNS:staging-proxy,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > "$state_dir/tls/extensions"
      openssl x509 -req -days 30 -in "$state_dir/tls/server.csr" -CA "$state_dir/tls/ca.crt" -CAkey "$state_dir/tls/ca.key" \
        -CAcreateserial -extfile "$state_dir/tls/extensions" -out "$state_dir/tls/server.crt" 2>/dev/null
    fi
    compose config --quiet
    compose build staging-app
    compose up -d --wait staging-db
    compose run --rm --no-deps staging-seed
    compose up -d --wait staging-app
    compose up -d --wait --no-deps --force-recreate staging-proxy
    echo 'Local staging started. Run bash scripts/api-staging.sh check for HTTPS acceptance checks.'
    ;;
  check) compose run --rm --no-deps staging-check ;;
  status) compose ps ;;
  down) compose down ;;
  *) echo 'Usage: bash scripts/api-staging.sh up|check|status|down' >&2; exit 1 ;;
esac
