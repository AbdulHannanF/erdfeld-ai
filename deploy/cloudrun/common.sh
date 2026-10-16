#!/usr/bin/env bash
# Shared settings and helpers for the Cloud Run scripts. Sourced, not run.
# Settings come from the environment or from deploy/cloudrun/.env.deploy (see env.example).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ -f "$HERE/.env.deploy" ]; then
  # shellcheck disable=SC1091
  . "$HERE/.env.deploy"
fi

: "${PROJECT_ID:?set PROJECT_ID (env or deploy/cloudrun/.env.deploy)}"

# PROFILE=free (default): stays inside Google Cloud's always-free tier plus the Cloud SQL 30-day free
# trial. Scale to zero everywhere, request-based billing, small instances.
# PROFILE=paid: Cloud SQL db-f1-micro created by setup.sh, web always warm (min-instances 1, CPU always
# allocated), geo 2 CPU / 4 GiB. Costs money 24/7. See README.
PROFILE="${PROFILE:-free}"
case "$PROFILE" in free | paid) ;; *) die "PROFILE must be free or paid (got '$PROFILE')" ;; esac

REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-erdfeld}"
WEB_SERVICE="${WEB_SERVICE:-erdfeld-web}"
GEO_SERVICE="${GEO_SERVICE:-erdfeld-geo}"
TITILER_SERVICE="${TITILER_SERVICE:-erdfeld-titiler}"
MIGRATE_JOB="${MIGRATE_JOB:-erdfeld-migrate}"
# Exact upstream release, never `latest`. Cloud Run cannot pull from ghcr.io, so deploy.sh rebuilds
# it into Artifact Registry with Cloud Build (deploy/cloudrun/titiler/Dockerfile).
TITILER_VERSION="${TITILER_VERSION:-2.4.0}"
# `all` (default) keeps the geo service on Cloud Run IAM with a public URL: only callers holding an
# ID token for it get in. `internal` also restricts ingress to the VPC, but then the web service
# needs VPC egress (--network/--subnet, all traffic) and Cloud NAT; see README.
GEO_INGRESS="${GEO_INGRESS:-all}"
# Optional: a gcsfuse-backed bucket for the geo composite cache (see README). Empty = container disk.
GEO_CACHE_BUCKET="${GEO_CACHE_BUCKET:-}"
# Optional: model override for the Gemini provider, e.g. gemma-4-31b-it (open model, near-zero cost).
GEOAGENT_MODEL_GEMINI="${GEOAGENT_MODEL_GEMINI:-}"
# The model inspect_imagery looks through, on Gemini's OpenAI-compatible endpoint with the same key.
# Empty = no vision model (the operation then refuses and says why).
VLM_MODEL="${VLM_MODEL-gemini-3.8-flash}"

# Database. DB_MODE=vm (free default): PostgreSQL 16 in a container on an always-free e2-micro VM, fully
# scripted, no external IP, reached from Cloud Run by Direct VPC egress. DB_MODE=cloudsql-trial: a Cloud
# SQL free-trial instance you create by hand in the console (30 days). DB_MODE=cloudsql (paid default):
# setup.sh creates a Cloud SQL instance.
if [ "$PROFILE" = free ]; then DB_MODE="${DB_MODE:-vm}"; else DB_MODE="${DB_MODE:-cloudsql}"; fi
case "$DB_MODE" in vm | cloudsql-trial | cloudsql) ;; *) die "DB_MODE must be vm, cloudsql-trial or cloudsql" ;; esac
[ "$PROFILE" = free ] || [ "$DB_MODE" = cloudsql ] || die "PROFILE=paid uses DB_MODE=cloudsql"

DB_VM="${DB_VM:-erdfeld-db}"
DB_ZONE="${DB_ZONE:-${REGION}-a}"
DB_VM_IP_NAME="${DB_VM}-ip"
DB_VM_TAG="erdfeld-db"
DB_SA_NAME="erdfeld-db"
DB_SA="${DB_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
PG_VERSION="${PG_VERSION:-16.6}"
if [ "$PROFILE" = free ]; then
  DB_NAME="${DB_NAME:-geoagent}"
  DB_USER="${DB_USER:-geoagent}"
else
  DB_NAME="${DB_NAME:-erdfeld}"
  DB_USER="${DB_USER:-erdfeld}"
fi
DB_RUN_FLAGS=()
SQL_CONNECTION=""
SQL_INSTANCE=""

if [ "$DB_MODE" = vm ]; then
  # Direct VPC egress: only private ranges go through the VPC, everything else leaves directly (no NAT).
  DB_RUN_FLAGS=(--network "$NETWORK" --subnet "$SUBNET" --vpc-egress private-ranges-only)
fi

if [ "$DB_MODE" = cloudsql-trial ]; then
  : "${CLOUDSQL_INSTANCE:?DB_MODE=cloudsql-trial needs CLOUDSQL_INSTANCE=project:region:instance}"
  case "$CLOUDSQL_INSTANCE" in
    *:*:*) ;;
    *) die "CLOUDSQL_INSTANCE must look like project:region:instance (see: gcloud sql instances describe NAME --format='value(connectionName)')" ;;
  esac
  SQL_CONNECTION="$CLOUDSQL_INSTANCE"
  SQL_REGION="$(printf '%s' "$CLOUDSQL_INSTANCE" | cut -d: -f2)"
  SQL_INSTANCE="${CLOUDSQL_INSTANCE##*:}"
  [ "$SQL_REGION" = "$REGION" ] ||
    die "Cloud SQL instance is in ${SQL_REGION} but REGION is ${REGION}: keep the connection in-region (set REGION=${SQL_REGION})"
  DB_RUN_FLAGS=(--set-cloudsql-instances "$SQL_CONNECTION")
fi

if [ "$PROFILE" = free ]; then
  # Cloud Run request-based billing, all inside the always-free tier (see README).
  # web is 2 GiB: map_flood and the Overture reads need headroom (a 1 GiB container died at ~510 MB of heap
  # in the 2026-10-15 live evaluation). 2 GiB x active seconds is 360,000 GiB-s at 50 hours a month, the same
  # 50 hours that 180,000 vCPU-s allows for one vCPU, so memory is not the limit that ends the free tier.
  WEB_MEMORY_MIB=2048
  WEB_FLAGS=(--cpu 1 --memory 2Gi --cpu-throttling --min-instances 0 --max-instances 2 --concurrency 40 --timeout 300)
  TITILER_FLAGS=(--cpu 1 --memory 1Gi --cpu-throttling --min-instances 0 --max-instances 2 --concurrency 20 --timeout 60)
  GEO_FLAGS=(--cpu 1 --memory 2Gi --cpu-throttling --min-instances 0 --max-instances 1 --concurrency 4 --timeout 900)
  # Smaller GDAL caches to fit 1 GiB.
  TITILER_CACHE_BYTES=134217728
  BUILD_CONFIG="$HERE/cloudbuild-web-free.yaml"
else
  SQL_INSTANCE="${SQL_INSTANCE:-erdfeld-db}"
  SQL_TIER="${SQL_TIER:-db-f1-micro}"
  SQL_CONNECTION="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
  DB_RUN_FLAGS=(--set-cloudsql-instances "$SQL_CONNECTION")
  # The job worker runs inside the web process, so CPU stays allocated and one instance stays up.
  WEB_MEMORY_MIB=2048
  WEB_FLAGS=(--cpu 2 --memory 2Gi --no-cpu-throttling --min-instances 1 --max-instances 3 --concurrency 40 --timeout 300)
  TITILER_FLAGS=(--cpu 2 --memory 2Gi --min-instances 0 --max-instances 5 --concurrency 40 --timeout 60)
  GEO_FLAGS=(--cpu 2 --memory 4Gi --min-instances 0 --max-instances 1 --concurrency 8 --timeout 900)
  TITILER_CACHE_BYTES=536870912
  BUILD_CONFIG="$HERE/cloudbuild-web.yaml"
fi

# Node's default old-space limit is a fraction of the machine's memory and is not sized for the container:
# set it to 75% of the web service's memory so V8 collects before the container is killed, leaving the
# rest for buffers (pixel grids), the native heap and the OS.
WEB_NODE_OPTIONS="--max-old-space-size=$((WEB_MEMORY_MIB * 3 / 4))"

REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
WEB_SA_NAME="erdfeld-web"
GEO_SA_NAME="erdfeld-geo"
WEB_SA="${WEB_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
GEO_SA="${GEO_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Secrets the web service and the migration job read. GEMINI_API_KEY is the only one you supply.
# Free profile: 3 secrets = 3 active versions, inside Secret Manager's 6 free active versions.
# NEXTAUTH_SECRET (only for GitHub sign-in, which is off) and METRICS_TOKEN (/api/metrics is open
# when it is unset) are skipped. There is no GEO_SERVICE_TOKEN: geo is protected by Cloud Run IAM.
if [ "$PROFILE" = free ]; then
  WEB_SECRETS=(DATABASE_URL GEMINI_API_KEY EVIDENCE_SIGNING_KEY)
else
  WEB_SECRETS=(DATABASE_URL GEMINI_API_KEY EVIDENCE_SIGNING_KEY NEXTAUTH_SECRET METRICS_TOKEN)
fi

# Git Bash on Windows rewrites arguments that look like Unix paths (/opt/... -> C:/Program Files/Git/opt/...)
# before gcloud sees them; container paths must reach Cloud Run unchanged. No effect on other systems.
gcloud_() { MSYS2_ARG_CONV_EXCL="^|^;/opt/;/cloudsql/;GEO_CACHE_DIR=;volume=" gcloud --project "$PROJECT_ID" "$@"; }

service_url() { gcloud_ run services describe "$1" --region "$REGION" --format='value(status.url)' 2>/dev/null || true; }

git_sha() { git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown; }
