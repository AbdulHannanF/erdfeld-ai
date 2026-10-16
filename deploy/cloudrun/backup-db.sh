#!/usr/bin/env bash
# Logical backup of the database on the free-profile VM (DB_MODE=vm): pg_dump through an IAP ssh tunnel
# (the VM has no external IP), gzip-compressed on this machine.
#
#   ./deploy/cloudrun/backup-db.sh [outfile.sql.gz]       # default: erdfeld-YYYYmmdd-HHMMSS.sql.gz
#
# Restore into a fresh database:
#   gunzip -c dump.sql.gz | gcloud compute ssh erdfeld-db --zone us-central1-a --tunnel-through-iap \
#     --command 'sudo docker exec -i $(sudo docker ps -q) psql -U geoagent geoagent'
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

[ "$DB_MODE" = vm ] || die "backup-db.sh is for DB_MODE=vm; for Cloud SQL use: gcloud sql export sql"
out="${1:-erdfeld-$(date +%Y%m%d-%H%M%S).sql.gz}"
log "dumping ${DB_NAME} from ${DB_VM} to ${out}"
gcloud_ compute ssh "$DB_VM" --zone "$DB_ZONE" --tunnel-through-iap --quiet \
  --command "sudo docker exec \$(sudo docker ps -q --filter ancestor=${REGISTRY}/postgres:${PG_VERSION}) pg_dump -U ${DB_USER} --no-owner ${DB_NAME}" |
  gzip >"$out"
[ -s "$out" ] || die "empty dump: check that the VM is running and the container is up"
log "wrote ${out} ($(wc -c <"$out") bytes)"
