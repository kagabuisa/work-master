#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
drill_id="wm-api-recovery-$$"
drill_dir=$(mktemp -d)
drill_image="work_master-invoice-app"
cleanup() {
  docker rm -f "$drill_id-runner" >/dev/null 2>&1 || true
  docker rm -f "$drill_id" >/dev/null 2>&1 || true
  docker network rm "$drill_id" >/dev/null 2>&1 || true
  rm -rf "$drill_dir"
}
trap cleanup EXIT
docker image inspect "$drill_image" >/dev/null 2>&1 || docker compose build invoice-app
docker network create --internal "$drill_id" >/dev/null
docker run -d --name "$drill_id" --network "$drill_id" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=work_master_source_hr_test -e POSTGRES_USER=test_user \
  -e POSTGRES_PASSWORD=local_test_only postgres:16-alpine >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$drill_id" pg_isready -U test_user -d work_master_source_hr_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Disposable PostgreSQL did not start.' >&2; exit 1; fi
run_fixture() {
  local database="$1" mode="$2"
  docker run --rm --name "$drill_id-runner" --network "$drill_id" --entrypoint sh --user "$(id -u):$(id -g)" \
    -v "$PWD:/workspace:ro" -v "$drill_dir:/drill-state" --tmpfs /workspace/data:mode=1777 -w /workspace \
    -e NODE_PATH=/app/node_modules -e NODE_ENV=test -e API_REQUEST_LOGS=false -e API_METRICS_INTERVAL_MS=0 \
    -e API_RECOVERY_DRILL=1 -e POSTGRES_URL="postgresql://test_user:local_test_only@$drill_id:5432/$database" \
    "$drill_image" -c "node scripts/api-recovery-fixture.js '$mode' /drill-state/state.json"
}
run_fixture work_master_source_hr_test seed
docker exec "$drill_id" pg_dump -U test_user -d work_master_source_hr_test --format=custom > "$drill_dir/backup.dump"
docker exec "$drill_id" createdb -U test_user work_master_restore_hr_test
docker exec -i "$drill_id" pg_restore -U test_user -d work_master_restore_hr_test --exit-on-error < "$drill_dir/backup.dump"
run_fixture work_master_restore_hr_test verify
echo 'Disposable API backup/restore drill passed; temporary data and credentials will be removed.'
