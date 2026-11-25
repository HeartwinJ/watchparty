# syntax=docker/dockerfile:1

# The runtime is plain Alpine plus the (stripped) node binary from the official image,
# instead of node:24-alpine itself: that image is ~175 MB, mostly npm/yarn/headers we don't
# need at runtime. ALPINE must match the node image's Alpine release (same musl/libstdc++).
ARG NODE_MAJOR=24
ARG ALPINE=3.24

# --- Build: client bundle + server compiled to plain JS ---------------------------------
# Output is architecture-independent, so this stage runs on the builder's native platform
# even for multi-arch builds (no QEMU for vite).
FROM --platform=$BUILDPLATFORM node:${NODE_MAJOR}-alpine${ALPINE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Typechecks/tests run in CI, the image build only produces artifacts
RUN npx vite build && npm run buildServer

# --- Production dependencies (pure JS, so also built natively) ---------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_MAJOR}-alpine${ALPINE} AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# --- Node binary for the target platform, debug symbols stripped (~12 MB smaller) --------
FROM node:${NODE_MAJOR}-alpine${ALPINE} AS node
RUN apk add --no-cache binutils && strip /usr/local/bin/node

# --- Runtime ------------------------------------------------------------------------------
FROM alpine:${ALPINE}
RUN apk add --no-cache libstdc++ tini su-exec \
  && addgroup -g 1000 node \
  && adduser -u 1000 -G node -s /sbin/nologin -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY package.json ./
COPY words ./words
COPY --from=build /src/build ./build
COPY --from=build /src/dist-server ./dist-server
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
  PORT=8080 \
  DATA_DIR=/app/data \
  NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=1"
VOLUME ["/app/data"]
EXPOSE 8080
# Starts as root so the entrypoint can fix ./data ownership, then drops to uid 1000 (node)

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/ping" || exit 1

# tini forwards SIGTERM to node (the entrypoint execs into it), which saves every room before exiting, and reaps zombies
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist-server/server.js"]
