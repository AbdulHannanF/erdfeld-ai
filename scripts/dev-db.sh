#!/usr/bin/env bash
# Local PostgreSQL 16 cluster for development and tests: data in ./.pgdata (git-ignored), port 5433.
#
#   scripts/dev-db.sh          create the cluster if missing, start it, print the DATABASE_URLs
#   scripts/dev-db.sh stop     stop it
#
# Needs the PostgreSQL 16 server binaries (initdb, pg_ctl); set PG_BIN if they are not on PATH
# or in /usr/lib/postgresql/16/bin. Postgres refuses to run as root, so when this script runs as
# root (a container) it runs the server as the `postgres` user.
#
# Windows (Git Bash, no admin rights): unzip the EDB portable PostgreSQL 16 binaries and point
# PG_BIN at their bin dir; PGDATA_DEV overrides the data directory (default ./.pgdata), e.g.
#   PG_BIN=/c/Users/you/pgsql16/bin PGDATA_DEV=/c/Users/you/pgsql16/data scripts/dev-db.sh
# On Windows no unix socket directory is configured and psql is taken from PG_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${PGDATA_DEV:-$ROOT/.pgdata}"
PORT="${PGPORT_DEV:-5433}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
[ -x "$PG_BIN/pg_ctl" ] || [ -x "$PG_BIN/pg_ctl.exe" ] || PG_BIN="$(dirname "$(command -v pg_ctl)")"
PSQL="$PG_BIN/psql"; [ -x "$PSQL" ] || [ -x "$PSQL.exe" ] || PSQL=psql
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) SOCKET_OPT="" ;;
  *) SOCKET_OPT="-c unix_socket_directories=/tmp" ;;
esac

run() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

if [ "${1:-}" = stop ]; then
  run "$PG_BIN/pg_ctl" -D "$DATA" stop -m fast
  exit 0
fi

if [ ! -f "$DATA/PG_VERSION" ]; then
  mkdir -p "$DATA"
  if [ "$(id -u)" = 0 ]; then chown postgres "$DATA"; fi
  # trust auth on localhost only: this cluster is a throwaway dev database
  run "$PG_BIN/initdb" -D "$DATA" -U geoagent --auth=trust -E UTF8 >/dev/null
fi

if ! run "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  run "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w \
    -o "-p $PORT -c listen_addresses=127.0.0.1 $SOCKET_OPT" start >/dev/null
fi

for db in geoagent geoagent_test; do
  "$PSQL" -h 127.0.0.1 -p "$PORT" -U geoagent -d postgres -Atc "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || "$PSQL" -h 127.0.0.1 -p "$PORT" -U geoagent -d postgres -qc "create database $db"
done

cat <<MSG
PostgreSQL 16 is running on 127.0.0.1:$PORT (data: $DATA)
  DATABASE_URL=postgresql://geoagent@127.0.0.1:$PORT/geoagent
  DATABASE_URL_TEST=postgresql://geoagent@127.0.0.1:$PORT/geoagent_test
Then: npx prisma migrate dev   (or: npx prisma migrate deploy)
MSG
