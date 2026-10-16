# Deploying Erdfeld AI to Google Cloud Run

Three Cloud Run services, one Cloud SQL database, Secret Manager. Plain `gcloud` scripts, no Terraform.
Status: written but never run against a real project (no gcloud account was available when it was
authored). Expect to fix small things on the first run. **Start with "Free profile" below**: it is the
default (`PROFILE=free`) and the rest of this file describes the paid layout unless it says otherwise.

```
browser ──> erdfeld-web (Next.js + job worker, public)
              ├─ Cloud SQL Postgres 16 (unix socket, Cloud Run connection)
              ├─ erdfeld-geo     (FastAPI, IAM-protected; web calls it with a Google ID token)
              └─ erdfeld-titiler (public; the browser fetches map tiles from it directly)
```

## Deploy

Needs `gcloud` (logged in, billing enabled on the project) and `openssl`.

```bash
cp deploy/cloudrun/env.example deploy/cloudrun/.env.deploy      # set PROJECT_ID (and REGION if not us-central1)
export GEMINI_API_KEY=...                                       # read once, stored in Secret Manager
./deploy/cloudrun/setup.sh        # APIs, Artifact Registry, service accounts, Cloud SQL, secrets (~10 min, Cloud SQL is slow)
./deploy/cloudrun/deploy.sh all   # titiler, geo, web image, migrations (Cloud Run Job), web
```

Later releases: `./deploy/cloudrun/deploy.sh web` (build, migrate, deploy). Every step checks before it
creates, so re-running is safe. Images are tagged by git commit and not rebuilt for a tag that exists.

Then: `curl https://<web-url>/api/health` should say `"status":"ok"`. A `config` array in the answer
names production misconfigurations (status `degraded`). The metrics token is in Secret Manager:
`gcloud secrets versions access latest --secret METRICS_TOKEN`, used as `Authorization: Bearer ...` on
`/api/metrics`.

## Free profile (default): designed to cost nothing

`PROFILE=free` (the default) stays inside Google Cloud's always-free tier. It is a demo setup. Expected
cost is 0 USD but it is **not guaranteed** (see "Where a charge can still happen"). `PROFILE=paid`
(Cloud SQL `db-f1-micro`, always-warm web) is the old behaviour and costs money 24/7. Everything below
describes the free profile; the "Deploy" text above applies to it with `PROFILE=free` in `.env.deploy`.

| What | Free profile | Free allowance it uses |
|---|---|---|
| Database | PostgreSQL 16 in a container on one `e2-micro` VM, us-central1-a, 30 GB `pd-standard`, Container-Optimized OS, no external IP | [Compute Engine free tier](https://cloud.google.com/free/docs/free-cloud-features#compute): one e2-micro per billing account per month (us-west1, us-central1, us-east1), 30 GB-months standard disk |
| Cloud Run | web 1 vCPU / **2 GiB** with `NODE_OPTIONS=--max-old-space-size=1536` (concurrency 40, timeout 300), titiler 1 vCPU / 1 GiB, geo 1 vCPU / 2 GiB (max 1 instance); all `--min-instances 0`, default CPU throttling (request-based billing), us-central1 | [Cloud Run free tier](https://cloud.google.com/run/pricing#free-tier): 2M requests, 180,000 vCPU-s, 360,000 GiB-s per month; 1 GB internet egress from North America |
| Web memory | 2 GiB, not 1 GiB: flood mapping and building/road reads need headroom (the 1 GiB container ran out of heap in the live evaluation of 2026-10-15). Still inside the free tier for demo traffic: 360,000 GiB-s a month at 2 GiB is 50 hours of active instance time, the same 50 hours that 180,000 vCPU-s allows on 1 vCPU, so vCPU time stays the tighter limit and the free-tier ceiling does not move. | Cloud Run free tier (GiB-seconds) |
| Images | geo image without torch/TimesFM; cleanup policy keeps the latest image per service | [Artifact Registry](https://cloud.google.com/artifact-registry/pricing): 0.5 GB free |
| Secrets | `GEMINI_API_KEY`, `DATABASE_URL`, `EVIDENCE_SIGNING_KEY` = 3 active versions; older versions are destroyed on re-set | [Secret Manager](https://cloud.google.com/secret-manager/pricing): 6 active versions, 10,000 access operations per month |
| Builds | Cloud Build default pool, no `machineType` (`cloudbuild-web-free.yaml`) | [Cloud Build](https://cloud.google.com/build/pricing): 120 build-minutes per day |
| Guard | 1 USD budget, e-mail alerts at 50/90/100% | free |
| LLM | Gemini API with `GEMINI_API_KEY` (your credits) | billed by Google AI, not this project |

Overview: [cloud.google.com/free](https://cloud.google.com/free). Free-tier terms change; re-check them.

### Owner steps, in order

1. Create a new Google Cloud project and link a billing account (Cloud Run, Cloud Build and Compute need
   billing enabled even when nothing is charged). Install `gcloud` and `openssl` and `node`; `gcloud auth login`.
2. `cp deploy/cloudrun/env.example deploy/cloudrun/.env.deploy`; set `PROJECT_ID` (leave `PROFILE=free`).
   Optional: `GEOAGENT_MODEL_GEMINI=gemma-4-31b-it`.
3. `export GEMINI_API_KEY=...` then `./deploy/cloudrun/setup.sh` (~10 minutes). Nothing to click.
4. `./deploy/cloudrun/deploy.sh all`, then `curl https://<web-url>/api/health`.
5. Before a demo: `./deploy/cloudrun/deploy.sh warm`.
6. Whenever: `./deploy/cloudrun/backup-db.sh`. To stop: `./deploy/cloudrun/deploy.sh teardown`.

### The database VM

- **Always free, no 30-day expiry**: the free tier covers one e2-micro per billing account, so do not run
  another e2-micro in that account. It has 1 GiB RAM shared with PostgreSQL, so Postgres is configured
  small (`shared_buffers=128MB`, `max_connections=60`). It is a single node with no HA and no automatic backup.
- **Private only.** `--no-address` (an external IPv4 is billed) and no Cloud NAT. Private Google Access is
  enabled on the subnet so the VM can pull its image from Artifact Registry; `setup.sh` mirrors `postgres:16.6`
  there with Cloud Build. The VM's internal IP is reserved (`erdfeld-db-ip`) so `DATABASE_URL` stays valid.
- **Network.** Cloud Run web and the migrate job use Direct VPC egress (`--network default --subnet default
  --vpc-egress private-ranges-only`), so only traffic to private ranges enters the VPC; everything else leaves
  directly. A firewall rule allows tcp:5432 only from the subnet range, and `pg_hba` accepts password
  (scram) logins only from that range. ssh is allowed only through IAP (`erdfeld-allow-iap-ssh`).
  In-region traffic between Cloud Run and the VM is billed only if it crosses zones (about 0.01 USD per GB).
- **Data** is on a host path (`/var/lib/erdfeld-pgdata`) on the boot disk, so it survives container and VM
  restarts. It is lost if the VM or its disk is deleted.
- **Password**: generated (or `DB_PASSWORD`), stored only in the `DATABASE_URL` secret and in the VM's
  container metadata (visible to project owners). The database and user are created by Postgres on first start.
- **Backups**: `./deploy/cloudrun/backup-db.sh` writes a gzip `pg_dump` over an IAP ssh tunnel (restore
  command in the script header). Run it before teardown or anything risky; there is no schedule.
- **Teardown keeps the VM**; `deploy.sh teardown --delete-db` deletes it and the data.
- **Alternative**: `DB_MODE=cloudsql-trial` uses a Cloud SQL
  [free-trial instance](https://cloud.google.com/sql/docs/postgres/free-trial-instance) that can only be
  created by hand in the console (new project, us-central1, HA off). Set `CLOUDSQL_INSTANCE=project:region:instance`.
  The trial lasts 30 days, then the instance stops serving; Google keeps the data for a 90-day grace period,
  during which you can upgrade it or export it (`gcloud sql export sql`). The connection must be in-region.

### Cold starts and the job worker

All three services scale to zero. The first request after idle waits for a cold start: web roughly 5-15 s,
geo 10-30 s, titiler a few seconds (estimates, not measurements). Warm up before a demo:

```bash
./deploy/cloudrun/deploy.sh warm
# by hand:
WEB=$(gcloud run services describe erdfeld-web --region us-central1 --format='value(status.url)')
for i in $(seq 1 10); do curl -fsS -m 60 "$WEB/api/health" | grep -q '"status":"ok"' && break; sleep 5; done
```

Instances idle out again after about 15 minutes without requests. The job worker runs inside the web
process (`src/instrumentation.ts`); with CPU throttling it only runs while a request is in flight. The UI
polls job status, so a job whose page is open keeps progressing; a job left running after the tab is closed
stalls and resumes on the next request. The paid profile avoids this with `--no-cpu-throttling --min-instances 1`.

### Image sizes

The geo image no longer installs `timesfm` and `torch`: they are the optional extra `timesfm` in
`services/geo/pyproject.toml` (TimesFM is off by default, `GEO_TIMESFM=0`, and asking for it returns a clear
400). Build with `--build-arg WITH_TIMESFM=1` to include them (about 1 GB more). Sizes are **estimates, not
measured** (Docker was not available): geo 300-450 MB compressed, web 150-250 MB, titiler 300-500 MB, postgres
about 150 MB. Together with only the latest version of each kept, that is likely 0.9-1.4 GB, above the 0.5 GB free
allowance; the excess is about 0.10 USD per GB-month, so expect cents, not zero. Measure after the first deploy:
`gcloud artifacts docker images list ${REGION}-docker.pkg.dev/PROJECT/erdfeld`. `setup.sh` installs the cleanup
policy (`set-cleanup-policies`: keep the newest version of each image, delete the rest after a day), so you
cannot roll back to older images.

### Gemini and Gemma

Planner calls use the Gemini API with `GEMINI_API_KEY`. For the open Gemma model through the same API (near
zero cost) set `GEOAGENT_MODEL_GEMINI=gemma-4-31b-it` in `.env.deploy` and run `deploy.sh deploy-web`.
Quality differs from Gemini; test before a demo.

### Budget guard and shutting down

`setup.sh` creates the budget `erdfeld-1usd` (1 USD, alerts at 50/90/100% by e-mail). A budget does **not**
stop spending. To stop quickly: `./deploy/cloudrun/deploy.sh teardown` deletes the three services, the
migrate job and the images, and keeps the database VM (and its secrets). Add `--delete-db` to delete the
VM too (after `backup-db.sh`).

### Where a charge can still happen

- Internet egress above 1 GB per month (map tiles and pages count); about 0.12 USD per GB.
- Cloud Run above 180,000 vCPU-s, 360,000 GiB-s or 2M requests per month.
- Artifact Registry above 0.5 GB (likely, see Image sizes); Cloud Build source/log storage in Cloud Storage.
- Cloud Build above 120 minutes per day.
- A second e2-micro, a larger disk, a non-free region, or an external IP in the same billing account.
- Secret Manager above 6 active versions or 10,000 access operations per month.
- Free-tier terms changing; Gemini/Gemma API usage (billed by Google AI).

## Decisions

- **erdfeld-web**: `--no-cpu-throttling` and `--min-instances 1`. The job worker runs inside the web
  process (`src/instrumentation.ts`); with CPU throttled outside requests it would stall. Timeout 300 s
  (agent runs stream over SSE), concurrency 40, port 3000. Runs as the unprivileged `node` user.
- **Migrations** run once per release as the Cloud Run Job `erdfeld-migrate` (same image, `prisma migrate
  deploy`, executed before the web revision is deployed), not on container start. The image entrypoint
  only migrates when `RUN_MIGRATIONS=1` (docker-compose sets it).
- **Build-time settings.** The Content-Security-Policy is computed when `next build` runs, from
  `TITILER_ENDPOINT`. `deploy.sh` therefore deploys titiler first and builds the web image with its
  URL (`cloudbuild-web.yaml`). If titiler's URL changes, rebuild the web image.
- **erdfeld-geo**: not publicly invokable (`--no-allow-unauthenticated`). The web service account has
  `roles/run.invoker`; the Node client (`src/app/api/agent/lib/geo-auth.ts`) fetches an ID token from the
  metadata server when `GEO_SERVICE_AUDIENCE` is set (the deploy sets it to the geo URL). Locally it is
  unset and no header is sent. The tiles proxy and `/api/health` use the same token.
  - `GEO_INGRESS=internal` (ingress restricted to the VPC) is supported by the script but is NOT the
    default: a Cloud Run service calling an internal-ingress one must route its egress through a VPC
    (Direct VPC egress, all traffic) and then needs Cloud NAT to reach STAC, Gemini, etc. IAM alone is
    already authenticated; add the VPC only if you want the extra network layer.
- **Geo cache and `max-instances=1`.** Composites are cached as COGs under `GEO_CACHE_DIR`
  (`/data/composites`) on the container's disk, and tile URLs carry the composite id. A second instance
  would not have the file and would answer 404, so the geo service is pinned to one instance (it also
  keeps its per-key locks correct). It scales up (2 CPU, 4 Gi), not out. Instance restarts lose the cache;
  composites are recomputed on demand, but a tile URL from before the restart 404s until recomputed.
  To keep the cache across restarts and share it between instances, set `GEO_CACHE_BUCKET=<bucket>`
  before `setup.sh` / `deploy.sh geo`: the bucket is mounted at `/data` through Cloud Run's gcsfuse
  volume (second-generation environment). Untested here; gcsfuse is slower than local disk and writes
  are whole-object, so keep `max-instances 1` until you have measured it.
- **erdfeld-titiler**: the official `developmentseed/titiler` image at the exact version in
  `TITILER_VERSION` (default 2.4.0), copied into Artifact Registry by Cloud Build because Cloud Run
  cannot pull from ghcr.io. It is public on purpose (browser tiles). GDAL environment is the one from
  docker-compose.yml. The app's `/cog` and `/stac` endpoints exist in that release (checked in the
  upstream source); the live tile paths have not been exercised against it.
- **Rate limiting** keys anonymous callers on the client IP: `GEOAGENT_TRUST_PROXY=cloudrun` takes the
  right-most `X-Forwarded-For` entry (what Google's front end appended). Set
  `GEOAGENT_TRUSTED_PROXY_HOPS=1` if you later put a load balancer in front. The buckets are per
  instance (in memory), so the effective limit is up to `max-instances` times the configured one.
- **Uploads stay off.** `ENABLE_UPLOADS` is not set: uploads write to `public/uploads` on the
  container disk, which Cloud Run does not persist or share between instances. Do not enable it here.
- **Production guards** (`src/lib/prod-checks.ts`): the server refuses to start with `AGENT_ALLOW_STUB=1`;
  a missing `EVIDENCE_SIGNING_KEY` (or GitHub sign-in without `NEXTAUTH_SECRET`) is logged as an error at
  start and shows as `degraded` with a `config` list in `/api/health`. `setup.sh` generates both secrets.

## Secrets (Secret Manager)

The free profile creates only `GEMINI_API_KEY`, `DATABASE_URL` and `EVIDENCE_SIGNING_KEY`
(`/api/metrics` is then open, and GitHub sign-in is unavailable until you add `NEXTAUTH_SECRET`).

| Secret | Origin |
|---|---|
| `GEMINI_API_KEY` | you (`export GEMINI_API_KEY`) |
| `DATABASE_URL` | generated with the database user, points at the Cloud SQL socket |
| `EVIDENCE_SIGNING_KEY` | generated Ed25519 key (base64 PEM). Rotating it makes old bundles unverifiable by the new key |
| `NEXTAUTH_SECRET` | generated |
| `METRICS_TOKEN` | generated; gates `/api/metrics` |

GitHub sign-in is optional: add `GITHUB_ID`, `GITHUB_SECRET` and `NEXTAUTH_URL` with
`gcloud run services update erdfeld-web --update-env-vars ...` (put the two secrets in Secret Manager).

## Cost

Paid profile only: Cloud SQL `db-f1-micro` and the always-on web instance (CPU always allocated) run
24/7; geo and titiler scale to zero. `deploy.sh teardown`, then `gcloud sql instances delete erdfeld-db`
when the contest is over. The free profile is described above.
