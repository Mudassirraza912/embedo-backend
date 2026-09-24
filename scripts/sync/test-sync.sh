#!/usr/bin/env bash
# End-to-end test of sync-catalog-to-vps.sh against a SCRATCH Postgres container that plays the VPS.
# Requires Docker and the local dev DB. Touches nothing but the throwaway container `synctest_pg`.
#   bash scripts/sync/test-sync.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C=synctest_pg; LOCAL=embedo_postgres
T="$(mktemp -d)"; PASS=0; FAIL=0
trap 'docker rm -f $C >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
q()  { docker exec -i $C psql -U embedo_user -d embedo_prod -t -A -v ON_ERROR_STOP=1 -c "$1" </dev/null; }
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1)); else echo "  FAIL  $1: expected '$3' got '$2'"; FAIL=$((FAIL+1)); fi; }

echo "== Start scratch 'VPS' database"
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --name $C -e POSTGRES_USER=embedo_user -e POSTGRES_PASSWORD=t -e POSTGRES_DB=embedo_prod pgvector/pgvector:pg16 >/dev/null
for i in $(seq 1 30); do docker exec $C pg_isready -U embedo_user -d embedo_prod >/dev/null 2>&1 && break; sleep 1; done
sleep 2
q "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
docker exec $LOCAL pg_dump -U postgres -d embedo_dev -s -t components -t datasheet_chunks --no-owner --no-privileges | docker exec -i $C psql -U embedo_user -d embedo_prod -q -v ON_ERROR_STOP=1 >/dev/null
q "CREATE TABLE users(id serial primary key, email text); INSERT INTO users(email) VALUES ('real-user@example.com'),('second@example.com')" >/dev/null
q "CREATE TABLE audit_log(id serial primary key, note text); INSERT INTO audit_log(note) VALUES ('keep me')" >/dev/null

echo "== Seed OLD prod-like data: same part numbers, different ids, stale specs, plus a prod-only part"
docker exec $LOCAL psql -U postgres -d embedo_dev -t -A -F'|' -c "SELECT part_number FROM components ORDER BY 1 LIMIT 40" > "$T/parts.txt"
while read -r pn; do
  q "INSERT INTO components(id,part_number,manufacturer,category,specs,datasheet_url,source) VALUES (gen_random_uuid(),'$pn','OLD','OLD','{\"old\":true}','http://old','seed')" >/dev/null
done < "$T/parts.txt"
q "INSERT INTO components(id,part_number,specs) VALUES (gen_random_uuid(),'PROD_ONLY_PART','{\"prodonly\":true}')" >/dev/null
q "INSERT INTO datasheet_chunks(id,component_id,chunk_text,page_number,embedding) SELECT gen_random_uuid(), id, 'old chunk', 1, array_fill(0.01::real, ARRAY[1536])::vector FROM components, generate_series(1,2)" >/dev/null
OLD_ID=$(q "SELECT id FROM components WHERE part_number='$(head -1 "$T/parts.txt")'")
PRODONLY_CHUNKS=$(q "SELECT count(*) FROM datasheet_chunks d JOIN components c ON c.id=d.component_id WHERE c.part_number='PROD_ONLY_PART'")
L_COMPS=$(docker exec $LOCAL psql -U postgres -d embedo_dev -t -A -c "SELECT count(*) FROM components")
L_CHUNKS=$(docker exec $LOCAL psql -U postgres -d embedo_dev -t -A -c "SELECT count(*) FROM datasheet_chunks")

export SYNC_TRANSPORT=local REMOTE_PG_CONTAINER=$C REMOTE_DB_USER=embedo_user REMOTE_DB=embedo_prod REMOTE_BACKUP_DIR="$T/backups"

echo "== TEST 1: --dry-run writes nothing"
bash "$HERE/sync-catalog-to-vps.sh" --dry-run | sed 's/^/    /'
chk "dry run left components unchanged" "$(q "SELECT count(*) FROM components WHERE specs->>'old'='true'")" "40"
chk "dry run created no backup dir" "$([ -d "$T/backups" ] && echo yes || echo no)" "no"

echo "== TEST 2: real sync"
bash "$HERE/sync-catalog-to-vps.sh" --yes | sed 's/^/    /'
chk "matched component id preserved" "$(q "SELECT id FROM components WHERE part_number='$(head -1 "$T/parts.txt")'")" "$OLD_ID"
chk "no stale specs left" "$(q "SELECT count(*) FROM components WHERE specs->>'old'='true'")" "0"
chk "components total = local + prod-only" "$(q "SELECT count(*) FROM components")" "$((L_COMPS + 1))"
chk "chunks for synced components = local chunks" "$(q "SELECT count(*) FROM datasheet_chunks WHERE component_id IN (SELECT id FROM components WHERE part_number<>'PROD_ONLY_PART')")" "$L_CHUNKS"
chk "no leftover 'old chunk' rows" "$(q "SELECT count(*) FROM datasheet_chunks WHERE chunk_text='old chunk' AND component_id IN (SELECT id FROM components WHERE part_number<>'PROD_ONLY_PART')")" "0"
chk "prod-only part untouched" "$(q "SELECT specs->>'prodonly' FROM components WHERE part_number='PROD_ONLY_PART'")" "true"
chk "prod-only part's chunks untouched" "$(q "SELECT count(*) FROM datasheet_chunks d JOIN components c ON c.id=d.component_id WHERE c.part_number='PROD_ONLY_PART'")" "$PRODONLY_CHUNKS"
chk "users table untouched" "$(q "SELECT count(*) FROM users")" "2"
chk "audit_log table untouched" "$(q "SELECT note FROM audit_log")" "keep me"
chk "staging tables removed" "$(q "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'stg_%'")" "0"
chk "backup file created" "$(ls "$T"/backups/embedo_prod_before-catalog-sync_*.dump 2>/dev/null | wc -l | tr -d ' ')" "1"
chk "specs carry the new-pipeline document id" "$(q "SELECT count(*) FROM components WHERE specs->'_provenance'->>'documentId' LIKE 'sha256:%'")" "$(docker exec $LOCAL psql -U postgres -d embedo_dev -t -A -c "SELECT count(*) FROM components WHERE specs->'_provenance'->>'documentId' LIKE 'sha256:%'")"

echo "== TEST 3: re-running is idempotent"
bash "$HERE/sync-catalog-to-vps.sh" --yes >/dev/null
chk "components unchanged after second run" "$(q "SELECT count(*) FROM components")" "$((L_COMPS + 1))"
chk "chunks unchanged after second run" "$(q "SELECT count(*) FROM datasheet_chunks WHERE component_id IN (SELECT id FROM components WHERE part_number<>'PROD_ONLY_PART')")" "$L_CHUNKS"

echo "== TEST 4: merge SQL refuses EMPTY staging and rolls back (must not wipe the catalog)"
q "CREATE TABLE stg_components (LIKE components); CREATE TABLE stg_datasheet_chunks (LIKE datasheet_chunks)" >/dev/null
BEFORE=$(q "SELECT count(*) FROM datasheet_chunks")
set +e; docker exec -i $C psql -1 -U embedo_user -d embedo_prod -v ON_ERROR_STOP=1 < "$HERE/merge-catalog.sql" >/dev/null 2>"$T/err.txt"; RC=$?; set -e
chk "merge exits non-zero on empty staging" "$([ $RC -ne 0 ] && echo yes || echo no)" "yes"
chk "error names the cause" "$(grep -c 'staging is empty' "$T/err.txt")" "1"
chk "chunks unchanged after refused merge" "$(q "SELECT count(*) FROM datasheet_chunks")" "$BEFORE"
q "DROP TABLE stg_components, stg_datasheet_chunks" >/dev/null

echo "== TEST 5: a component with ZERO exported chunks must not erase its live chunks"
q "CREATE TABLE stg_components (LIKE components); CREATE TABLE stg_datasheet_chunks (LIKE datasheet_chunks)" >/dev/null
q "INSERT INTO stg_components SELECT * FROM components WHERE part_number='PROD_ONLY_PART'" >/dev/null
q "INSERT INTO stg_components(id,part_number,specs) VALUES (gen_random_uuid(),'BRAND_NEW','{}')" >/dev/null
q "INSERT INTO stg_datasheet_chunks(id,component_id,chunk_text,page_number,embedding) SELECT gen_random_uuid(), id, 'new', 1, array_fill(0.02::real, ARRAY[1536])::vector FROM stg_components WHERE part_number='BRAND_NEW'" >/dev/null
docker exec -i $C psql -1 -U embedo_user -d embedo_prod -v ON_ERROR_STOP=1 < "$HERE/merge-catalog.sql" >/dev/null 2>&1
chk "prod-only part kept its chunks (it had none in the export)" "$(q "SELECT count(*) FROM datasheet_chunks d JOIN components c ON c.id=d.component_id WHERE c.part_number='PROD_ONLY_PART'")" "$PRODONLY_CHUNKS"
chk "brand-new part inserted with its chunk" "$(q "SELECT count(*) FROM datasheet_chunks d JOIN components c ON c.id=d.component_id WHERE c.part_number='BRAND_NEW'")" "1"

echo "== TEST 6: if the merge itself breaks, the SCRIPT must fail loudly and change nothing"
cp -R "$HERE" "$T/broken"; printf '\nSELECT 1/0;\n' >> "$T/broken/merge-catalog.sql"
q "UPDATE components SET specs = specs || '{\"marker\":1}' WHERE part_number='PROD_ONLY_PART'" >/dev/null
set +e; bash "$T/broken/sync-catalog-to-vps.sh" --yes >"$T/broken.out" 2>&1; RC=$?; set -e
chk "script exits non-zero when the merge fails" "$([ $RC -ne 0 ] && echo yes || echo no)" "yes"
chk "script says the merge was rolled back" "$(grep -c 'rolled back' "$T/broken.out")" "1"
chk "live data unchanged (marker still present, nothing half-merged)" "$(q "SELECT specs->>'marker' FROM components WHERE part_number='PROD_ONLY_PART'")" "1"
chk "component count unchanged" "$(q "SELECT count(*) FROM components")" "$((L_COMPS + 2))"

echo; echo "RESULT: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
