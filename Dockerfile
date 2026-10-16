#
# Build args (all optional; they are baked in at BUILD time, so pass them to `docker build`):
#   TITILER_ENDPOINT   origin of the raster tile server the browser talks to. next.config.ts puts it in the
#                      Content-Security-Policy at build time, so a wrong value here means tiles are blocked.
#   CSP_CONNECT_EXTRA  extra space-separated origins the browser may load from.
#   GIT_SHA            commit recorded in evidence bundles (there is no .git in the build context).
#
# Runtime: runs as the unprivileged `node` user. Migrations are NOT run on start unless
# RUN_MIGRATIONS=1 (docker-compose sets it); on Cloud Run they run as a Job from this same image.
#
# onnxruntime-node (parked CV feature, GEOAGENT_ENABLE_CV) has no musl binary: leave that flag off here.

# ---- stage 1: install dependencies (linux native binaries) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node is optional (its binary download may be blocked); npm skips it if so.
RUN npm ci

# ---- stage 2: build ----
FROM node:22-alpine AS builder
WORKDIR /app
ARG TITILER_ENDPOINT=""
ARG CSP_CONNECT_EXTRA=""
ARG GIT_SHA=""
ENV TITILER_ENDPOINT=$TITILER_ENDPOINT \
    CSP_CONNECT_EXTRA=$CSP_CONNECT_EXTRA \
    GIT_SHA=$GIT_SHA \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
# Generate the Prisma client before the source is copied: it only depends on the schema, so a
# source-only change reuses this layer.
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
# next build + copy static/public into standalone (see package.json build script)
RUN npm run build

# ---- stage 3: minimal production runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# Cloud Run sets PORT itself; HOSTNAME must stay 0.0.0.0 for the standalone server to listen outside the container.

# Prisma's query engine needs openssl. The standalone output prunes node_modules, so the Prisma CLI
# that runs `prisma migrate deploy` is installed separately, at the version in package-lock.json.
COPY --from=builder /app/node_modules/prisma/package.json /tmp/prisma-package.json
RUN apk add --no-cache openssl \
 && npm install --prefix /opt/prisma --no-save --no-audit --no-fund \
      "prisma@$(node -p "require('/tmp/prisma-package.json').version")" \
 && rm -rf /tmp/prisma-package.json /root/.npm

# Copy the complete standalone output (includes pruned node_modules, .next/static, public)
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Ensure static and public are present (build script copies them, but be explicit)
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRs in case the script was checked out with Windows line endings.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/api/health" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
