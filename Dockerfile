FROM node:22-bookworm-slim AS builder

# node-pty falls back to a source build when its bundled prebuild does not
# match this platform; the toolchain keeps that fallback working (it is a
# no-op otherwise — the published package ships linux-x64/arm64 prebuilds).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# bin/ ships before install: postinstall runs `node bin/prepare-terminal.js`
# (repairs node-pty macOS spawn-helper bits; a safe no-op on linux).
COPY package.json package-lock.json bin/ ./
# npm install (not npm ci): the lockfile is intentionally not updated for the
# terminal port, so it does not satisfy npm ci's in-sync requirement.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=30141 \
    PI_WEB_HOSTNAME=0.0.0.0 \
    PI_WEB_NO_OPEN=1 \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_WORKSPACES_DIR=/home/node/pi-workspaces

WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts

USER node
EXPOSE 30141

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "30141"]
