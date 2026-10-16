#!/usr/bin/env bash
# One-time (and safe to re-run) project setup: APIs, Artifact Registry (+ cleanup policy), service
# accounts, database, Secret Manager secrets and a 1 USD billing budget. Every step checks first.
#
# PROFILE=free (default), DB_MODE=vm (default): fully automatic, nothing to click.
#   GEMINI_API_KEY=... ./deploy/cloudrun/setup.sh
#   Creates an always-free e2-micro VM running PostgreSQL 16 (no external IP, private network only).
# PROFILE=free, DB_MODE=cloudsql-trial: after creating the free-trial instance in the console:
#   DB_MODE=cloudsql-trial CLOUDSQL_INSTANCE=project:region:instance GEMINI_API_KEY=... ./deploy/cloudrun/setup.sh
# PROFILE=paid: also CREATES a Cloud SQL instance (billable 24/7).
#
# Optional DB_PASSWORD (letters, digits, _ . ~ -); otherwise a random one is generated.
# Needs: gcloud (logged in), openssl, node (to URL-encode the password).
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

command -v gcloud >/dev/null || die "gcloud not found"
command -v openssl >/dev/null || die "openssl not found"
command -v node >/dev/null || die "node not found"
case "${DB_PASSWORD:-x}" in *[!A-Za-z0-9_.~-]*) die "DB_PASSWORD may only contain letters, digits and _ . ~ -" ;; esac

log "profile: ${PROFILE}, database: ${DB_MODE}"
if [ "$DB_MODE" = cloudsql-trial ] && [ "$(printf '%s' "$CLOUDSQL_INSTANCE" | cut -d: -f1)" != "$PROJECT_ID" ]; then
  die "the Cloud SQL instance must live in PROJECT_ID (${PROJECT_ID})"
fi

log "enabling APIs"
gcloud_ services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com compute.googleapis.com \
  billingbudgets.googleapis.com cloudbilling.googleapis.com

log "Artifact Registry repository ${AR_REPO}"
gcloud_ artifacts repositories describe "$AR_REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud_ artifacts repositories create "$AR_REPO" --repository-format=docker --location "$REGION" \
    --description="Erdfeld AI images"

if [ "$PROFILE" = free ]; then
  # Keep only the newest version of each image (web, geo, titiler, postgres) to stay near the 0.5 GB free
  # storage. Versions older than a day that are not the newest per image are deleted; Keep wins over Delete.
  log "Artifact Registry cleanup policy: keep only the latest image per service"
  policy="$(mktemp)"
  cat >"$policy" <<'JSON'
[
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "1d"}},
  {"name": "keep-latest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 1}}
]
JSON
  gcloud_ artifacts repositories set-cleanup-policies "$AR_REPO" --location "$REGION" --policy="$policy" --no-dry-run
  rm -f "$policy"
fi

log "service accounts"
for sa in "$WEB_SA_NAME" "$GEO_SA_NAME"; do
  gcloud_ iam service-accounts describe "${sa}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud_ iam service-accounts create "$sa" --display-name "Erdfeld AI ${sa}"
done
if [ "$DB_MODE" != vm ]; then
  # The web service (and the migration job) connect to Cloud SQL through the Cloud Run connection.
  gcloud_ projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${WEB_SA}" \
    --role roles/cloudsql.client --condition=None >/dev/null
fi
# The geo cache bucket, when used, is written by the geo service account.
if [ -n "$GEO_CACHE_BUCKET" ]; then
  gcloud_ storage buckets describe "gs://${GEO_CACHE_BUCKET}" >/dev/null 2>&1 ||
    gcloud_ storage buckets create "gs://${GEO_CACHE_BUCKET}" --location "$REGION" --uniform-bucket-level-access
  gcloud_ storage buckets add-iam-policy-binding "gs://${GEO_CACHE_BUCKET}" \
    --member "serviceAccount:${GEO_SA}" --role roles/storage.objectUser >/dev/null
fi

secret_exists() { gcloud_ secrets describe "$1" >/dev/null 2>&1; }
secret_has_version() { [ -n "$(gcloud_ secrets versions list "$1" --filter='state=ENABLED' --limit 1 --format='value(name)' 2>/dev/null)" ]; }
ensure_secret() { secret_exists "$1" || gcloud_ secrets create "$1" --replication-policy=automatic >/dev/null; }
# Adds a version, then destroys every older one so each secret keeps exactly one active version
# (Secret Manager's free tier covers 6 active versions in total).
add_version() {
  printf '%s' "$2" | gcloud_ secrets versions add "$1" --data-file=- >/dev/null
  newest="$(gcloud_ secrets versions list "$1" --filter='state=ENABLED' --sort-by=~createTime --limit 1 --format='value(name)')"
  for v in $(gcloud_ secrets versions list "$1" --filter='state=ENABLED OR state=DISABLED' --format='value(name)'); do
    [ "$v" = "$newest" ] || gcloud_ secrets versions destroy "$v" --secret "$1" --quiet >/dev/null
  done
}
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
# The password inside the current DATABASE_URL secret (empty when there is none).
current_db_password() {
  secret_has_version DATABASE_URL || return 0
  gcloud_ secrets versions access latest --secret DATABASE_URL |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(decodeURIComponent(new URL(s.trim()).password)))'
}

log "secrets"
for s in "${WEB_SECRETS[@]}"; do ensure_secret "$s"; done

if [ "$DB_MODE" = vm ]; then
  # ---- PostgreSQL 16 on an always-free e2-micro (Container-Optimized OS), private network only ----
  log "network ${NETWORK}/${SUBNET}: Private Google Access, firewall"
  gcloud_ compute networks describe "$NETWORK" >/dev/null 2>&1 ||
    gcloud_ compute networks create "$NETWORK" --subnet-mode=auto
  gcloud_ compute networks subnets update "$SUBNET" --region "$REGION" --enable-private-ip-google-access
  range="$(gcloud_ compute networks subnets describe "$SUBNET" --region "$REGION" --format='value(ipCidrRange)')"
  [ -n "$range" ] || die "subnet ${SUBNET} not found in ${REGION} on network ${NETWORK}"
  # PostgreSQL only from the subnet (Cloud Run Direct VPC egress sources from it); ssh only through IAP.
  gcloud_ compute firewall-rules describe erdfeld-allow-pg >/dev/null 2>&1 ||
    gcloud_ compute firewall-rules create erdfeld-allow-pg --network "$NETWORK" --direction INGRESS \
      --allow tcp:5432 --source-ranges "$range" --target-tags "$DB_VM_TAG"
  gcloud_ compute firewall-rules describe erdfeld-allow-iap-ssh >/dev/null 2>&1 ||
    gcloud_ compute firewall-rules create erdfeld-allow-iap-ssh --network "$NETWORK" --direction INGRESS \
      --allow tcp:22 --source-ranges 35.235.240.0/20 --target-tags "$DB_VM_TAG"

  gcloud_ iam service-accounts describe "$DB_SA" >/dev/null 2>&1 ||
    gcloud_ iam service-accounts create "$DB_SA_NAME" --display-name "Erdfeld AI database VM"
  gcloud_ projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${DB_SA}" \
    --role roles/artifactregistry.reader --condition=None >/dev/null

  pg_image="${REGISTRY}/postgres:${PG_VERSION}"
  if ! gcloud_ artifacts docker images describe "$pg_image" >/dev/null 2>&1; then
    log "mirroring postgres:${PG_VERSION} into Artifact Registry (the VM has no internet)"
    ctx="$(mktemp -d)"
    printf 'FROM postgres:%s\n' "$PG_VERSION" >"$ctx/Dockerfile"
    gcloud_ builds submit "$ctx" --tag "$pg_image"
    rm -rf "$ctx"
  fi

  gcloud_ compute addresses describe "$DB_VM_IP_NAME" --region "$REGION" >/dev/null 2>&1 ||
    gcloud_ compute addresses create "$DB_VM_IP_NAME" --region "$REGION" --subnet "$SUBNET"
  db_ip="$(gcloud_ compute addresses describe "$DB_VM_IP_NAME" --region "$REGION" --format='value(address)')"

  # Same password across re-runs: DB_PASSWORD, else the one in DATABASE_URL, else a new random one.
  db_pass="${DB_PASSWORD:-$(current_db_password)}"
  db_pass="${db_pass:-$(openssl rand -hex 24)}"

  if gcloud_ compute instances describe "$DB_VM" --zone "$DB_ZONE" >/dev/null 2>&1; then
    log "database VM ${DB_VM} already exists (${db_ip})"
  else
    log "creating database VM ${DB_VM} (e2-micro, 30 GB pd-standard, ${DB_ZONE}, no external IP)"
    conf=/var/lib/postgresql/data/pg_hba_erdfeld.conf
    # pg_hba: the in-container socket, and password logins only from the subnet. The file sits next to
    # (not inside) PGDATA, which is the pgdata subdirectory of the persistent host path.
    pg_script="printf 'local all all trust\\nhost all all 127.0.0.1/32 scram-sha-256\\nhost all all ${range} scram-sha-256\\n' > ${conf}; exec docker-entrypoint.sh postgres -c 'listen_addresses=*' -c hba_file=${conf} -c max_connections=60 -c shared_buffers=128MB -c work_mem=4MB"
    # Container-Optimized OS runs the mirrored postgres image from a startup script (the old
    # create-with-container agent is discontinued). The script re-runs on every boot and is idempotent;
    # POSTGRES_USER / POSTGRES_DB create the user and the database on the first start. COS drops inbound
    # traffic by default, so 5432 is opened in the host firewall (the VPC rule still limits it to the subnet).
    startup="$(mktemp)"
    cat >"$startup" <<SCRIPT
#!/bin/bash
set -e
export HOME=/var/lib/erdfeld-home
mkdir -p "\$HOME" /var/lib/erdfeld-pgdata
iptables -C INPUT -p tcp --dport 5432 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 5432 -j ACCEPT
docker-credential-gcr configure-docker --registries=${REGION}-docker.pkg.dev
if ! docker inspect erdfeld-pg >/dev/null 2>&1; then
  docker run -d --name erdfeld-pg --restart always -p 5432:5432 \
    -v /var/lib/erdfeld-pgdata:/var/lib/postgresql/data \
    -e POSTGRES_USER='${DB_USER}' -e POSTGRES_PASSWORD='${db_pass}' -e POSTGRES_DB='${DB_NAME}' \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    ${pg_image} sh -c "${pg_script}"
else
  docker start erdfeld-pg >/dev/null
fi
SCRIPT
    gcloud_ compute instances create "$DB_VM" --zone "$DB_ZONE" --machine-type e2-micro       --image-family cos-stable --image-project cos-cloud       --boot-disk-size 30GB --boot-disk-type pd-standard       --network "$NETWORK" --subnet "$SUBNET" --no-address --private-network-ip "$db_ip"       --tags "$DB_VM_TAG" --service-account "$DB_SA" --scopes cloud-platform       --metadata-from-file startup-script="$startup"
    rm -f "$startup"
  fi
  # The password lives in the VM's container metadata (project owners can read it) and in this secret only.
  if [ "$(current_db_password)" != "$db_pass" ]; then
    add_version DATABASE_URL "postgresql://${DB_USER}:$(urlenc "$db_pass")@${db_ip}:5432/${DB_NAME}"
  fi
else
  if [ "$DB_MODE" = cloudsql-trial ]; then
    log "Cloud SQL instance ${SQL_INSTANCE} (free trial, created by hand in the console)"
    state="$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(state)' 2>/dev/null || true)"
    [ -n "$state" ] || die "Cloud SQL instance ${SQL_INSTANCE} not found in ${PROJECT_ID}: create it in the console first"
    [ "$state" = RUNNABLE ] || die "Cloud SQL instance ${SQL_INSTANCE} is ${state}, not RUNNABLE (trial ended or stopped?)"
    actual="$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
    [ "$actual" = "$SQL_CONNECTION" ] || die "CLOUDSQL_INSTANCE is ${SQL_CONNECTION} but the instance reports ${actual}"
  else
    log "Cloud SQL instance ${SQL_INSTANCE} (Postgres 16, ${SQL_TIER}): BILLABLE 24/7"
    if ! gcloud_ sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
      # Shared-core tiers exist only in the Enterprise edition. Takes several minutes.
      gcloud_ sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE \
        --tier "$SQL_TIER" --region "$REGION" --storage-size=10GB --storage-auto-increase \
        --availability-type=ZONAL --backup-start-time=03:00
    fi
  fi
  gcloud_ sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" >/dev/null 2>&1 ||
    gcloud_ sql databases create "$DB_NAME" --instance "$SQL_INSTANCE"

  # DATABASE_URL: Prisma reaches Cloud SQL through the unix socket the Cloud Run connection mounts.
  db_url() { printf 'postgresql://%s:%s@localhost/%s?host=/cloudsql/%s' "$DB_USER" "$(urlenc "$1")" "$DB_NAME" "$SQL_CONNECTION"; }
  user_exists=0
  gcloud_ sql users list --instance "$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER" && user_exists=1
  if [ "$user_exists" = 0 ]; then
    db_pass="${DB_PASSWORD:-$(openssl rand -hex 24)}"
    gcloud_ sql users create "$DB_USER" --instance "$SQL_INSTANCE" --password "$db_pass" >/dev/null
    add_version DATABASE_URL "$(db_url "$db_pass")"
  elif ! secret_has_version DATABASE_URL || [ -n "${DB_PASSWORD:-}" ]; then
    [ -n "${DB_PASSWORD:-}" ] ||
      die "database user ${DB_USER} exists but secret DATABASE_URL has no value: export DB_PASSWORD (its password) and re-run"
    # The built-in postgres user keeps the password you set in the console; any other user is aligned to it.
    [ "$DB_USER" = postgres ] ||
      gcloud_ sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --password "$DB_PASSWORD" >/dev/null
    add_version DATABASE_URL "$(db_url "$DB_PASSWORD")"
  fi
fi

# Generated once; rotating either invalidates what was signed with it (bundles, sessions).
secret_has_version EVIDENCE_SIGNING_KEY ||
  add_version EVIDENCE_SIGNING_KEY "$(openssl genpkey -algorithm ed25519 | openssl base64 -A)"
if [ "$PROFILE" = paid ]; then
  secret_has_version NEXTAUTH_SECRET || add_version NEXTAUTH_SECRET "$(openssl rand -base64 32)"
  secret_has_version METRICS_TOKEN || add_version METRICS_TOKEN "$(openssl rand -hex 24)"
fi

# GEMINI_API_KEY: stored when missing; FORCE_GEMINI_KEY=1 replaces it (old version destroyed).
if ! secret_has_version GEMINI_API_KEY || [ "${FORCE_GEMINI_KEY:-0}" = 1 ]; then
  [ -n "${GEMINI_API_KEY:-}" ] || die "GEMINI_API_KEY has no value yet: export GEMINI_API_KEY and re-run"
  add_version GEMINI_API_KEY "$GEMINI_API_KEY"
fi

for s in "${WEB_SECRETS[@]}"; do
  gcloud_ secrets add-iam-policy-binding "$s" --member "serviceAccount:${WEB_SA}" \
    --role roles/secretmanager.secretAccessor >/dev/null
done

if [ "$PROFILE" = free ]; then
  # A budget sends e-mail alerts; it does NOT cap spending. Delete the services with `deploy.sh teardown`.
  log "billing budget: 1 USD, alerts at 50/90/100%"
  account="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's|^billingAccounts/||')"
  if [ -z "$account" ]; then
    log "WARNING: PROJECT_ID has no billing account linked, so no budget was created (Cloud Run and Cloud Build need billing)"
  elif [ -n "$(gcloud billing budgets list --billing-project "$PROJECT_ID" --billing-account "$account" --filter='displayName=erdfeld-1usd' --format='value(name)' 2>/dev/null)" ]; then
    log "budget erdfeld-1usd already exists"
  else
    gcloud billing budgets create --billing-project "$PROJECT_ID" --billing-account "$account" --display-name erdfeld-1usd \
      --budget-amount 1USD --filter-projects "projects/${PROJECT_ID}" \
      --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
  fi
fi

log "setup done. Next: ./deploy/cloudrun/deploy.sh all"
