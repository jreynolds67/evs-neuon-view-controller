# Pinned to 20.19-alpine (>= 20.15) because server/zip.js imports { crc32 } from node:zlib,
# which was added in Node 20.15. ESM validates named core imports at load, so a floating
# node:20-alpine tag resolving to an older 20.x would crash the WHOLE app on startup, not
# just backups. Bump deliberately.
FROM node:20.19-alpine

WORKDIR /app

# Install deps first for better layer caching. tzdata lets TZ (e.g. America/New_York) resolve
# to a real zone so the backup scheduler fires at LOCAL wall-clock time and file timestamps
# read in local time — otherwise the container runs in UTC and "03:00" means 03:00 UTC.
RUN apk add --no-cache tzdata
# npm ci (not install): installs EXACTLY what the lockfile pins, and fails the build if the
# lockfile is missing or out of sync — a floating dependency resolved at build time is how two
# "identical" deploys end up running different code. The non-wildcard COPY backs that up: a
# build without the lockfile should fail loudly here, not silently produce an unpinned image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY server ./server
COPY public ./public
COPY private ./private

# Config lives on a mounted volume so it survives redeploys
ENV CONFIG_PATH=/data/config.json
ENV PORT=8080
VOLUME ["/data"]

EXPOSE 8080

# Catch a wedged-but-alive process (event loop stuck, port bound but unresponsive) that
# `restart: unless-stopped` alone wouldn't notice, since that only reacts to process exit.
# Hits the local, board-independent /api/time so a down board never marks us unhealthy.
# Uses $PORT so it follows a port override.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/time" || exit 1

CMD ["node", "server/index.js"]
