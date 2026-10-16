#!/bin/sh
# Start the server (the CMD). With RUN_MIGRATIONS=1 (docker-compose), apply pending database
# migrations first. Concurrent replicas are safe: `prisma migrate deploy` takes a Postgres
# advisory lock. A failed migration stops the container instead of serving against a schema the
# code does not match.
#
# Cloud Run does not set RUN_MIGRATIONS: migrations run once per release as a Cloud Run Job from
# this same image (deploy/cloudrun/), not on every instance start.
set -e
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  /opt/prisma/node_modules/.bin/prisma migrate deploy --schema ./prisma/schema.prisma
fi
exec "$@"
