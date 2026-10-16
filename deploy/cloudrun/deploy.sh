#!/usr/bin/env bash
# Build and deploy the three services, run the database migrations in between.
#
#   ./deploy/cloudrun/deploy.sh all            # titiler, geo, build web, migrate, web
#   ./deploy/cloudrun/deploy.sh web            # after a code change: build web, migrate, deploy web
#   ./deploy/cloudrun/deploy.sh titiler|geo|build|migrate|deploy-web
#   ./deploy/cloudrun/deploy.sh warm           # wake the scale-to-zero services (before a demo)
#   ./deploy/cloudrun/deploy.sh teardown       # delete the 3 services, migrate job and images; keeps the database
#   ./deploy/cloudrun/deploy.sh teardown --delete-db   # same, and deletes the database VM (data lost)
#
# Idempotent: images are tagged by git commit and not rebuilt when that tag already exists;
# `gcloud run deploy` and `run jobs deploy` create or update. Run setup.sh first.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)}"
[ -n "$TAG" ] || die "not a git checkout: set IMAGE_TAG"
WEB_IMAGE="${REGISTRY}/web:${TAG}"
GEO_IMAGE="${REGISTRY}/geo:${TAG}"
TITILER_IMAGE="${REGISTRY}/titiler:${TITILER_VERSION}"

image_exists() { gcloud_ artifacts docker images describe "$1" >/dev/null 2>&1; }

deploy_titiler() {
  if ! image_exists "$TITILER_IMAGE"; then
    log "mirroring titiler ${TITILER_VERSION} into Artifact Registry (Cloud Run cannot pull ghcr.io)"
    ctx="$(mktemp -d)"
    printf 'FROM ghcr.io/developmentseed/titiler:%s\n' "$TITILER_VERSION" >"$ctx/Dockerfile"
    gcloud_ builds submit "$ctx" --tag "$TITILER_IMAGE"
    rm -rf "$ctx"
  fi
  log "deploying ${TITILER_SERVICE}"
  # Public on purpose: the browser fetches map tiles from it directly. It serves only what a
  # caller points it at (public COGs), holds no secrets and no state. GDAL settings: fast
  # remote-COG reads, as in docker-compose.yml.
  gcloud_ run deploy "$TITILER_SERVICE" --image "$TITILER_IMAGE" --region "$REGION" --port 8080 \
    --allow-unauthenticated "${TITILER_FLAGS[@]}" \
    --set-env-vars "^|^GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR|GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES|GDAL_HTTP_MULTIPLEX=YES|GDAL_HTTP_VERSION=2|VSI_CACHE=TRUE|VSI_CACHE_SIZE=${TITILER_CACHE_BYTES}|CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif,.tiff,.TIF,.TIFF,.cog,.COG|CPL_VSIL_CURL_CACHE_SIZE=${TITILER_CACHE_BYTES}"
}

deploy_geo() {
  if ! image_exists "$GEO_IMAGE"; then
    log "building the geo service image"
    gcloud_ builds submit "$REPO_ROOT/services/geo" --tag "$GEO_IMAGE"
  fi
  log "deploying ${GEO_SERVICE} (max 1 instance: its composite cache is local, see README)"
  extra=()
  if [ -n "$GEO_CACHE_BUCKET" ]; then
    extra+=(--execution-environment gen2
      --add-volume "name=geo-data,type=cloud-storage,bucket=${GEO_CACHE_BUCKET}"
      --add-volume-mount "volume=geo-data,mount-path=/data")
  fi
  gcloud_ run deploy "$GEO_SERVICE" --image "$GEO_IMAGE" --region "$REGION" --port 8100 \
    --no-allow-unauthenticated --ingress "$GEO_INGRESS" --service-account "$GEO_SA" \
    "${GEO_FLAGS[@]}" \
    --set-env-vars "GEO_CACHE_DIR=/data/composites" ${extra[@]+"${extra[@]}"}
  # Only the web service may call it.
  gcloud_ run services add-iam-policy-binding "$GEO_SERVICE" --region "$REGION" \
    --member "serviceAccount:${WEB_SA}" --role roles/run.invoker >/dev/null
}

build_web() {
  if image_exists "$WEB_IMAGE"; then log "web image ${WEB_IMAGE} already built"; return; fi
  titiler_url="$(service_url "$TITILER_SERVICE")"
  [ -n "$titiler_url" ] || die "deploy titiler first: its URL goes into the web build (CSP)"
  log "building the web image (TITILER_ENDPOINT=${titiler_url})"
  gcloud_ builds submit "$REPO_ROOT" --config "$BUILD_CONFIG" \
    --substitutions "_IMAGE=${WEB_IMAGE},_TITILER_ENDPOINT=${titiler_url},_GIT_SHA=$(git_sha)"
}

secrets_flag() { local out="" s; for s in "$@"; do out+="${out:+,}${s}=${s}:latest"; done; printf '%s' "$out"; }

migrate() {
  log "running database migrations (Cloud Run job ${MIGRATE_JOB})"
  gcloud_ run jobs deploy "$MIGRATE_JOB" --image "$WEB_IMAGE" --region "$REGION" \
    --service-account "$WEB_SA" "${DB_RUN_FLAGS[@]}" \
    --set-secrets "$(secrets_flag DATABASE_URL)" \
    --command node --args "^|^/opt/prisma/node_modules/prisma/build/index.js|migrate|deploy|--schema|./prisma/schema.prisma" \
    --max-retries 2 --task-timeout 600
  gcloud_ run jobs execute "$MIGRATE_JOB" --region "$REGION" --wait
}

deploy_web() {
  geo_url="$(service_url "$GEO_SERVICE")"
  titiler_url="$(service_url "$TITILER_SERVICE")"
  [ -n "$geo_url" ] && [ -n "$titiler_url" ] || die "deploy titiler and geo first"
  log "deploying ${WEB_SERVICE}"
  # paid: --no-cpu-throttling + min-instances 1 keep the in-process job worker polling between requests.
  # free: request-based billing, scale to zero; the worker only runs while a request is in flight (the
  # UI polls, so job runs still progress). ENABLE_UPLOADS and AGENT_ALLOW_STUB are deliberately not set
  # (uploads write to local disk; the stub provider is test-only).
  env="GEO_SERVICE_URL=${geo_url},GEO_SERVICE_AUDIENCE=${geo_url},TITILER_ENDPOINT=${titiler_url},GEOAGENT_TRUST_PROXY=cloudrun,GEOAGENT_DEFAULT_PROVIDER=gemini"
  # NODE_OPTIONS contains no commas, so it is safe in the comma-separated --set-env-vars list.
  env+=",NODE_OPTIONS=${WEB_NODE_OPTIONS}"
  [ -z "$GEOAGENT_MODEL_GEMINI" ] || env+=",GEOAGENT_MODEL_GEMINI=${GEOAGENT_MODEL_GEMINI}"
  secrets="$(secrets_flag "${WEB_SECRETS[@]}")"
  # inspect_imagery: Gemini vision. The endpoint does not end in /v1, so the wire is named; the key is
  # the GEMINI_API_KEY secret under a second name (no new secret).
  if [ -n "$VLM_MODEL" ]; then
    env+=",VLM_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai,VLM_WIRE=openai,VLM_MODEL=${VLM_MODEL}"
    secrets+=",VLM_API_KEY=GEMINI_API_KEY:latest"
  fi
  gcloud_ run deploy "$WEB_SERVICE" --image "$WEB_IMAGE" --region "$REGION" --port 3000 \
    --allow-unauthenticated --service-account "$WEB_SA" \
    "${WEB_FLAGS[@]}" \
    "${DB_RUN_FLAGS[@]}" \
    --set-env-vars "$env" \
    --set-secrets "$secrets"
  url="$(service_url "$WEB_SERVICE")"
  log "deployed: ${url}"
  log "check:    curl -s ${url}/api/health   (expect status ok)"
}

# Scale-to-zero services need a cold start (web ~5-15 s, geo ~10-30 s). web's /api/health also calls geo
# with its ID token, so one loop wakes web and geo; titiler is poked through /healthz.
warm() {
  web_url="$(service_url "$WEB_SERVICE")"
  titiler_url="$(service_url "$TITILER_SERVICE")"
  [ -n "$web_url" ] || die "web service not deployed"
  log "warming up (up to 10 tries)"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS -m 60 -o /dev/null "${titiler_url}/healthz" || true
    if curl -fsS -m 60 "${web_url}/api/health" | grep -q '"status":"ok"'; then
      log "warm: ${web_url}"
      return
    fi
    log "try ${i}: not ready yet"
    sleep 5
  done
  die "web did not report status ok: curl -s ${web_url}/api/health"
}

# Removes everything that serves traffic or can cost money. Keeps the database and the secrets, so a
# later `deploy.sh all` brings the app back with its data.
teardown() {
  log "deleting services, migrate job and images in ${PROJECT_ID}; the database is kept"
  for svc in "$WEB_SERVICE" "$GEO_SERVICE" "$TITILER_SERVICE"; do
    if gcloud_ run services describe "$svc" --region "$REGION" >/dev/null 2>&1; then
      gcloud_ run services delete "$svc" --region "$REGION" --quiet
    fi
  done
  if gcloud_ run jobs describe "$MIGRATE_JOB" --region "$REGION" >/dev/null 2>&1; then
    gcloud_ run jobs delete "$MIGRATE_JOB" --region "$REGION" --quiet
  fi
  # The postgres image stays (the VM re-pulls it after a restart).
  for img in web geo titiler; do
    gcloud_ artifacts docker images delete "${REGISTRY}/${img}" --delete-tags --quiet 2>/dev/null || true
  done
  if [ "${2:-}" = --delete-db ] && [ "$DB_MODE" = vm ]; then
    log "deleting the database VM ${DB_VM} and its disk: ALL DATA IS LOST (use backup-db.sh first)"
    gcloud_ compute instances delete "$DB_VM" --zone "$DB_ZONE" --quiet
  fi
  log "done. Database kept (${DB_MODE}). Redeploy with: deploy.sh all"
}

case "${1:-}" in
  titiler) deploy_titiler ;;
  geo) deploy_geo ;;
  build) build_web ;;
  migrate) migrate ;;
  deploy-web) deploy_web ;;
  web) build_web; migrate; deploy_web ;;
  all) deploy_titiler; deploy_geo; build_web; migrate; deploy_web ;;
  warm) warm ;;
  teardown) teardown "$@" ;;
  *) die "usage: deploy.sh all|web|titiler|geo|build|migrate|deploy-web|warm|teardown" ;;
esac
