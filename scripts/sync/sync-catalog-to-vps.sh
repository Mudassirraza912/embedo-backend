#!/usr/bin/env bash
# ==============================================================================
# One-command sync of the datasheet catalog: local DB -> VPS DB.
#
#   npm run sync:vps                 # preflight, confirm, backup, sync, verify
#   npm run sync:vps -- --dry-run    # preflight + what would change; writes nothing
#   npm run sync:vps -- --yes        # skip the confirmation prompt
#
# Syncs ONLY the `components` and `datasheet_chunks` tables (matched by part_number, live ids kept).
# Users, sessions, AI-call ledger, audit log and everything else on the VPS are never touched.
# A full pg_dump of the VPS DB is taken first; the merge runs as one transaction with assertions.
#
# Config: scripts/sync/.env.sync (git-ignored; copy .env.sync.example). Auth: your SSH key, or
# export VPS_PASSWORD for one run (read via the environment only; never stored or put on a command line).
# ==============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.env.sync" ] && set -a && . "$HERE/.env.sync" && set +a

VPS_HOST="${VPS_HOST:-}"
VPS_USER="${VPS_USER:-root}"
REMOTE_PG_CONTAINER="${REMOTE_PG_CONTAINER:-embedo-prod-postgres}"
REMOTE_DB_USER="${REMOTE_DB_USER:-embedo_user}"
REMOTE_DB="${REMOTE_DB:-embedo_prod}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-/root/backups}"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-embedo_postgres}"
LOCAL_DB_USER="${LOCAL_DB_USER:-postgres}"
LOCAL_DB="${LOCAL_DB:-embedo_dev}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
# SYNC_TRANSPORT=local runs the "remote" side on this machine (used by the script's own end-to-end test).
SYNC_TRANSPORT="${SYNC_TRANSPORT:-ssh}"

DRY_RUN=0; ASSUME_YES=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n 2,17p "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "    ${G}✔${N} $*"; }
warn() { echo "    ${Y}!${N} $*"; }
die()  { echo "    ${R}✘ $*${N}" >&2; exit 1; }

if [ "$SYNC_TRANSPORT" = "ssh" ] && [ -z "$VPS_HOST" ]; then
  die "VPS_HOST is not set. Copy scripts/sync/.env.sync.example to scripts/sync/.env.sync and fill it in."
fi

# ── transport: run a shell command / copy a file on the "remote" ────────────────────────────────
# One authenticated connection is reused for every step (ControlMaster). Opening ~20 separate SSH
# sessions made an occasional login attempt get refused (seen on the first real run).
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30
          -o ControlMaster=auto -o "ControlPath=/tmp/embedo-sync-$$.sock" -o ControlPersist=120)
r_sh() { # stdin is passed through
  if [ "$SYNC_TRANSPORT" = "local" ]; then bash -c "$1"; return; fi
  if [ -n "${VPS_PASSWORD:-}" ]; then SSHPASS="$VPS_PASSWORD" sshpass -e ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" "$1"
  else ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" "$1"; fi
}
r_put() { # r_put <local file> <remote path>
  if [ "$SYNC_TRANSPORT" = "local" ]; then cp "$1" "$2"; return; fi
  if [ -n "${VPS_PASSWORD:-}" ]; then SSHPASS="$VPS_PASSWORD" sshpass -e scp "${SSH_OPTS[@]}" -q "$1" "$VPS_USER@$VPS_HOST:$2"
  else scp "${SSH_OPTS[@]}" -q "$1" "$VPS_USER@$VPS_HOST:$2"; fi
}
if [ -n "${VPS_PASSWORD:-}" ] && ! command -v sshpass >/dev/null; then die "VPS_PASSWORD is set but sshpass is not installed (brew install sshpass), or use an SSH key."; fi

l_sql() { printf '%s\n' "$1" | docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$LOCAL_DB_USER" -d "$LOCAL_DB" -t -A -v ON_ERROR_STOP=1 -f -; }
r_psql_cmd="docker exec -i $REMOTE_PG_CONTAINER psql -U $REMOTE_DB_USER -d $REMOTE_DB -v ON_ERROR_STOP=1"
r_sql() { printf '%s\n' "$1" | r_sh "$r_psql_cmd -t -A -f -"; }

STAMP="$(date +%Y%m%d-%H%M%S)"
LTMP="$(mktemp -d)"
if [ "$SYNC_TRANSPORT" = "local" ]; then RDIR="${LTMP}/remote"; mkdir -p "$RDIR"; else RDIR="/root/catalog-sync-$STAMP"; fi
BACKUP=""
cleanup() {
  rm -rf "$LTMP"
  # close the shared SSH connection
  if [ "$SYNC_TRANSPORT" = "ssh" ]; then ssh "${SSH_OPTS[@]}" -O exit "$VPS_USER@$VPS_HOST" >/dev/null 2>&1 || true; fi
}
on_error() {
  echo; echo "${R}Sync FAILED.${N} The merge is transactional, so the live catalog is either fully updated or unchanged."
  [ -n "$BACKUP" ] && echo "Full pre-sync backup on the VPS: $BACKUP"
  echo "Leftover staging tables/files (if any) are harmless and are removed at the start of the next run."
}
trap 'on_error' ERR
trap 'cleanup' EXIT

# ── 1. Preflight ────────────────────────────────────────────────────────────────────────────────
step "Preflight"
docker ps --format '{{.Names}}' | grep -qx "$LOCAL_PG_CONTAINER" || die "Local Postgres container '$LOCAL_PG_CONTAINER' is not running."
L_COMPS=$(l_sql "SELECT count(*) FROM components")
L_CHUNKS=$(l_sql "SELECT count(*) FROM datasheet_chunks")
L_CURRENT=$(l_sql "SELECT count(*) FROM components WHERE specs->'_provenance'->>'documentId' LIKE 'sha256:%'")
L_BADEMB=$(l_sql "SELECT count(*) FROM datasheet_chunks WHERE embedding IS NULL")
ok "local:  $L_COMPS components ($L_CURRENT on the current pipeline), $L_CHUNKS chunks"
[ "$L_COMPS" -gt 0 ] || die "Local catalog is empty; nothing to sync."
[ "$L_BADEMB" -eq 0 ] || die "$L_BADEMB local chunks have no embedding; fix the local data first."

r_sh "true" || die "Cannot reach the VPS (${VPS_USER}@${VPS_HOST:-local}). Check VPS_HOST / your SSH key / VPS_PASSWORD."
r_sh "docker ps --format '{{.Names}}' | grep -qx '$REMOTE_PG_CONTAINER'" || die "Postgres container '$REMOTE_PG_CONTAINER' is not running on the VPS."
R_COMPS=$(r_sql "SELECT count(*) FROM components")
R_CHUNKS=$(r_sql "SELECT count(*) FROM datasheet_chunks")
R_CURRENT=$(r_sql "SELECT count(*) FROM components WHERE specs->'_provenance'->>'documentId' LIKE 'sha256:%'")
ok "remote: $R_COMPS components ($R_CURRENT on the current pipeline), $R_CHUNKS chunks"

LOCAL_PARTS=$(l_sql "SELECT part_number FROM components ORDER BY 1")
REMOTE_PARTS=$(r_sql "SELECT part_number FROM components ORDER BY 1")
WILL_UPDATE=$(comm -12 <(printf '%s\n' "$LOCAL_PARTS") <(printf '%s\n' "$REMOTE_PARTS") | grep -c . || true)
WILL_INSERT=$(comm -23 <(printf '%s\n' "$LOCAL_PARTS") <(printf '%s\n' "$REMOTE_PARTS") | grep -c . || true)
UNTOUCHED=$(comm -13 <(printf '%s\n' "$LOCAL_PARTS") <(printf '%s\n' "$REMOTE_PARTS") | grep -c . || true)
ok "plan:   update $WILL_UPDATE, insert $WILL_INSERT, leave untouched $UNTOUCHED (on the VPS only)"

if [ "$L_COMPS" -lt $(( R_COMPS / 2 )) ] && [ "$FORCE" -ne 1 ]; then
  die "Local has far fewer components ($L_COMPS) than the VPS ($R_COMPS). Wrong database? Re-run with --force if this is intended."
fi
[ "$L_CURRENT" -gt 0 ] || warn "No local component is on the current pipeline (no _provenance.documentId); you may be syncing old data."

if [ "$DRY_RUN" -eq 1 ]; then
  echo; echo "${G}Dry run complete. Nothing was written.${N}"; exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  echo
  echo "About to REPLACE the datasheet catalog on ${VPS_HOST:-local target} ($REMOTE_DB) with your local one."
  echo "Only components + datasheet_chunks change; a full backup is taken first."
  printf "Type 'sync' to continue: "
  read -r ANSWER < /dev/tty || ANSWER=""
  [ "$ANSWER" = "sync" ] || die "Cancelled."
fi

# ── 2. Backup ───────────────────────────────────────────────────────────────────────────────────
step "Backing up the VPS database (full pg_dump)"
BACKUP="$REMOTE_BACKUP_DIR/embedo_prod_before-catalog-sync_$STAMP.dump"
r_sh "mkdir -p '$REMOTE_BACKUP_DIR' && docker exec $REMOTE_PG_CONTAINER pg_dump -U $REMOTE_DB_USER -d $REMOTE_DB -Fc > '$BACKUP'"
r_sh "docker exec -i $REMOTE_PG_CONTAINER pg_restore -l < '$BACKUP' | grep -q 'TABLE DATA public components'" || die "Backup verification failed; aborting before any change."
ok "backup: $BACKUP ($(r_sh "du -h '$BACKUP' | cut -f1"))"
r_sh "ls -1t '$REMOTE_BACKUP_DIR'/embedo_prod_before-catalog-sync_*.dump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f" || true

# ── 3. Export + transfer ────────────────────────────────────────────────────────────────────────
step "Exporting the local catalog and transferring it"
docker exec "$LOCAL_PG_CONTAINER" psql -U "$LOCAL_DB_USER" -d "$LOCAL_DB" -c "COPY components TO STDOUT" | gzip -6 > "$LTMP/components.copy.gz"
docker exec "$LOCAL_PG_CONTAINER" psql -U "$LOCAL_DB_USER" -d "$LOCAL_DB" -c "COPY datasheet_chunks TO STDOUT" | gzip -6 > "$LTMP/chunks.copy.gz"
r_sh "mkdir -p '$RDIR'"
r_put "$LTMP/components.copy.gz" "$RDIR/components.copy.gz"
r_put "$LTMP/chunks.copy.gz" "$RDIR/chunks.copy.gz"
r_put "$HERE/merge-catalog.sql" "$RDIR/merge-catalog.sql"
L_SUM=$( (cd "$LTMP" && (sha256sum components.copy.gz chunks.copy.gz 2>/dev/null || shasum -a 256 components.copy.gz chunks.copy.gz)) | awk '{print $1}' | tr '\n' ' ')
R_SUM=$(r_sh "cd '$RDIR' && (sha256sum components.copy.gz chunks.copy.gz 2>/dev/null || shasum -a 256 components.copy.gz chunks.copy.gz)" | awk '{print $1}' | tr '\n' ' ')
[ "$L_SUM" = "$R_SUM" ] || die "Checksum mismatch after transfer; nothing was changed."
ok "transferred and checksums match ($(du -h "$LTMP/chunks.copy.gz" | cut -f1) of chunks)"

# ── 4. Stage ────────────────────────────────────────────────────────────────────────────────────
step "Loading into staging tables (separate from the live tables)"
printf '%s\n' "DROP TABLE IF EXISTS stg_datasheet_chunks, stg_components; CREATE TABLE stg_components (LIKE components); CREATE TABLE stg_datasheet_chunks (LIKE datasheet_chunks);" | r_sh "$r_psql_cmd -q -f -"
r_sh "gunzip -c '$RDIR/components.copy.gz' | $r_psql_cmd -q -c 'COPY stg_components FROM STDIN'"
r_sh "gunzip -c '$RDIR/chunks.copy.gz' | $r_psql_cmd -q -c 'COPY stg_datasheet_chunks FROM STDIN'"
S_COMPS=$(r_sql "SELECT count(*) FROM stg_components"); S_CHUNKS=$(r_sql "SELECT count(*) FROM stg_datasheet_chunks")
[ "$S_COMPS" = "$L_COMPS" ] && [ "$S_CHUNKS" = "$L_CHUNKS" ] || die "Staged counts ($S_COMPS/$S_CHUNKS) differ from local ($L_COMPS/$L_CHUNKS); nothing was changed."
ok "staged $S_COMPS components, $S_CHUNKS chunks"

# ── 5. Merge (one transaction, with assertions) ────────────────────────────────────────────────
step "Merging (single transaction; any failed assertion rolls everything back)"
# The SQL file lives on the VPS host but psql runs inside the container, so it is fed over stdin
# (`-f <path>` would look for the file inside the container and fail). A failure must never be swallowed.
if ! MERGE_OUT=$(r_sh "$r_psql_cmd -1 < '$RDIR/merge-catalog.sql' 2>&1"); then
  echo "$MERGE_OUT" | tail -15 | sed 's/^/      /'
  die "Merge failed and was rolled back; the live catalog is unchanged."
fi
echo "$MERGE_OUT" | grep -E 'ASSERTIONS PASSED' | sed 's/^psql:[^ ]* *//;s/^/    /' || true
echo "$MERGE_OUT" | grep -q 'ASSERTIONS PASSED' || die "Merge finished without confirming its assertions; treating it as failed. Restore from $BACKUP if needed."
r_sh "$r_psql_cmd -q -c 'ANALYZE components; ANALYZE datasheet_chunks;'" || true

# ── 6. Verify + clean up ────────────────────────────────────────────────────────────────────────
step "Verifying"
F_COMPS=$(r_sql "SELECT count(*) FROM components")
F_CHUNKS=$(r_sql "SELECT count(*) FROM datasheet_chunks WHERE component_id IN (SELECT id FROM components WHERE part_number IN (SELECT part_number FROM stg_components))")
F_CURRENT=$(r_sql "SELECT count(*) FROM components WHERE specs->'_provenance'->>'documentId' LIKE 'sha256:%'")
F_BADEMB=$(r_sql "SELECT count(*) FROM datasheet_chunks WHERE embedding IS NULL OR vector_dims(embedding) <> 1536")
[ "$F_CHUNKS" = "$S_CHUNKS" ] || die "Post-merge chunk count $F_CHUNKS != $S_CHUNKS. Restore from $BACKUP if needed."
[ "$F_BADEMB" -eq 0 ] || die "$F_BADEMB live chunks with bad embeddings after merge."
ok "remote now: $F_COMPS components ($F_CURRENT on the current pipeline), $F_CHUNKS synced chunks, 0 bad embeddings"

r_sh "$r_psql_cmd -q -c 'DROP TABLE IF EXISTS stg_datasheet_chunks, stg_components;'" && r_sh "rm -rf '$RDIR'" && ok "staging tables and transfer files removed"

echo
echo "${G}${B}Catalog sync complete.${N}  Backup kept at: $BACKUP"
echo "To undo: restore only the two tables from that dump (pg_restore -t components -t datasheet_chunks --clean)."
