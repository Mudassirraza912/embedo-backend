#!/usr/bin/env bash
# ==============================================================================
# Embedo backend: server-side deploy step, run by GitHub Actions over SSH.
# ==============================================================================
#   bash ci-deploy.sh <production|development> <git-sha>
#
# The workflow has already rsynced the checked-out commit into "<APP_DIR>.incoming/".
# This script, running on the VPS as `etcpanel`:
#   1. takes a lock so two deploys of one environment never overlap
#   2. checks the live .env (never touched by deploys)
#   3. snapshots the current source and tags the current images as :rollback
#   4. syncs the incoming source into the live directory (.env* files are protected)
#   5. builds images, starts postgres + redis
#   6. production only: pg_dump before migrating
#   7. migrates (forward-only) and seeds (idempotent) in one-off containers
#   8. recreates api + worker and polls /api/v1/health
# If build, migrate, seed or the health check fails, the previous source and images are
# restored and api + worker are recreated from them. The database is NOT rolled back
# automatically: restore the pre-deploy dump by hand if a migration must be undone.
# ==============================================================================
set -Eeuo pipefail

ENV_NAME="${1:?usage: ci-deploy.sh <production|development> <git-sha>}"
GIT_SHA="${2:?usage: ci-deploy.sh <production|development> <git-sha>}"

case "$ENV_NAME" in
  production)
    APP_DIR=/home/etcpanel/apps/embedo-api
    PROJECT=embedo-api
    COMPOSE_FILE=docker-compose.prod.yml
    HEALTH_URL=http://127.0.0.1:4000/api/v1/health
    DB_CONTAINER=embedo-prod-postgres
    ;;
  development)
    APP_DIR=/home/etcpanel/apps/embedo-api-dev
    PROJECT=embedo-api-dev
    COMPOSE_FILE=docker-compose.development.yml
    HEALTH_URL=http://127.0.0.1:4001/api/v1/health
    DB_CONTAINER=embedo-dev-postgres
    ;;
  *) echo "Unknown environment '$ENV_NAME'" >&2; exit 2 ;;
esac

INCOMING="${APP_DIR}.incoming"
BACKUP_ROOT=/home/etcpanel/backups
TS="$(date -u +%Y%m%d-%H%M%S)"
SHORT_SHA="${GIT_SHA:0:7}"
KEEP_SOURCE_SNAPSHOTS=10
KEEP_DB_DUMPS=10

log()  { printf '\n\033[1;34m▶ [%s] %s\033[0m\n' "$ENV_NAME" "$*"; }
fail() { printf '\n\033[1;31m✖ [%s] %s\033[0m\n' "$ENV_NAME" "$*" >&2; exit 1; }

# --- 1. lock ---------------------------------------------------------------------
exec 9>"/home/etcpanel/.deploy-${ENV_NAME}.lock"
flock -w 900 9 || fail "Another ${ENV_NAME} deploy is still running (waited 15 min)."

[ -d "$INCOMING" ] || fail "$INCOMING is missing. The workflow rsync step did not run."
[ -d "$APP_DIR" ]  || fail "$APP_DIR is missing. Run the one-time server setup first."
cd "$APP_DIR"

# --- 2. .env guard rails ----------------------------------------------------------
[ -f .env ] || fail ".env not found in $APP_DIR (deploys never create or overwrite it)."
grep -qE '^NODE_ENV="?production"?$' .env || fail "NODE_ENV in .env must be 'production' (the image has no dev deps)."
grep -qE '^OPENAI_API_KEY=sk-' .env        || fail "OPENAI_API_KEY is not set in .env."
if grep -qE '^(JWT_ACCESS_SECRET|DASHBOARD_PASSWORD)=.*(your-|change-me|placeholder|example)' .env; then
  fail "Placeholder secrets detected in .env."
fi

C=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")
mkdir -p "$BACKUP_ROOT/releases" "$BACKUP_ROOT/db"
chmod 700 "$BACKUP_ROOT"

# --- 3. snapshot current source + images ------------------------------------------
SNAPSHOT="$BACKUP_ROOT/releases/backend-${ENV_NAME}-${TS}.tar.gz"
log "Snapshotting current source to $SNAPSHOT"
tar --exclude='./node_modules' --exclude='./dist' --exclude='./.env' --exclude='./.env*' \
    -czf "$SNAPSHOT" -C "$APP_DIR" .
ls -1t "$BACKUP_ROOT"/releases/backend-"${ENV_NAME}"-*.tar.gz | tail -n +$((KEEP_SOURCE_SNAPSHOTS + 1)) | xargs -r rm -f

HAVE_ROLLBACK_IMAGES=1
for svc in api worker; do
  if docker image inspect "${PROJECT}-${svc}:latest" >/dev/null 2>&1; then
    docker image tag "${PROJECT}-${svc}:latest" "${PROJECT}-${svc}:rollback"
  else
    HAVE_ROLLBACK_IMAGES=0
  fi
done

ROLLED_BACK=0
rollback() {
  local code="${1:-1}"
  [ "$ROLLED_BACK" = 1 ] && exit "$code"
  ROLLED_BACK=1
  printf '\n\033[1;31m✖ [%s] Deploy of %s failed (exit %s). Rolling back code and images.\033[0m\n' "$ENV_NAME" "$SHORT_SHA" "$code" >&2
  cd "$APP_DIR"
  # restore previous source (keeps .env*, node_modules and dist untouched)
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' ! -name '.env*' ! -name 'node_modules' ! -name 'dist' -exec rm -rf {} +
  tar -xzf "$SNAPSHOT" -C "$APP_DIR"
  if [ "$HAVE_ROLLBACK_IMAGES" = 1 ]; then
    for svc in api worker; do docker image tag "${PROJECT}-${svc}:rollback" "${PROJECT}-${svc}:latest"; done
    "${C[@]}" up -d --no-build --force-recreate api worker || true
  fi
  echo "Rolled back. Previous release is running again (DB schema was not rolled back)." >&2
  exit "$code"
}
trap 'rollback $?' ERR

# --- 4. sync incoming source into the live dir ------------------------------------
log "Syncing $SHORT_SHA into $APP_DIR"
# Protected paths are server-only files that are not in git; --delete must never remove them.
rsync -a --delete \
  --filter='P /.env' --filter='P /.env*' --filter='P /.release' \
  --filter='P /CLAUDE.md' --filter='P /AGENTS.md' --filter='P /DEPLOY.md' --filter='P /FIXES.md' \
  --filter='P /deploy.sh' --filter='P /data/' --filter='P /.DS_Store' \
  --exclude='/.env' --exclude='node_modules/' --exclude='/dist/' --exclude='.git/' \
  "$INCOMING"/ "$APP_DIR"/

# --- 5. build + infra -------------------------------------------------------------
log "Building images"
"${C[@]}" build api worker
log "Starting postgres and redis"
"${C[@]}" up -d --wait --wait-timeout 120 postgres redis

# --- 6. pre-migration dump (production) -------------------------------------------
if [ "$ENV_NAME" = production ]; then
  DB_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- | tr -d "\"'" || true)"; DB_USER="${DB_USER:-embedo_user}"
  DB_NAME="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- | tr -d "\"'" || true)";   DB_NAME="${DB_NAME:-embedo_prod}"
  DUMP="$BACKUP_ROOT/db/${DB_NAME}_predeploy_${TS}_${SHORT_SHA}.dump"
  log "pg_dump to $DUMP"
  ( umask 077; docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$DUMP" )
  [ -s "$DUMP" ] || { echo "pg_dump produced an empty file." >&2; rollback 1; }
  ls -1t "$BACKUP_ROOT"/db/*_predeploy_*.dump | tail -n +$((KEEP_DB_DUMPS + 1)) | xargs -r rm -f
fi

# --- 7. migrate + seed ------------------------------------------------------------
log "Applying migrations (prisma migrate deploy, forward-only)"
"${C[@]}" run --rm --no-deps -T api node dist/scripts/migrate.js
log "Seeding (idempotent, never overwrites)"
"${C[@]}" run --rm --no-deps -T api npm run db:seed

# --- 8. roll out + health ---------------------------------------------------------
log "Recreating api and worker"
"${C[@]}" up -d --no-build --remove-orphans api worker

log "Waiting for $HEALTH_URL"
ok=0
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)"
  if [ "$code" = 200 ]; then ok=1; break; fi
  sleep 4
done
if [ "$ok" != 1 ]; then
  echo "Health check did not return 200." >&2
  "${C[@]}" logs api --tail 80 || true
  rollback 1
fi

trap - ERR
echo "$SHORT_SHA $TS" > "$APP_DIR/.release"
docker image prune -f >/dev/null 2>&1 || true
"${C[@]}" ps
log "Deployed $SHORT_SHA to $ENV_NAME ✔"
