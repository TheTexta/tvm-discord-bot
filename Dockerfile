FROM node:22-bookworm AS dependencies

WORKDIR /usr/app
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Compile against bookworm's SQLite/glibc rather than incompatible upstream prebuilds.
RUN npm ci --omit=dev --build-from-source=sqlite3 --sqlite=/usr

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.source="https://github.com/TheTexta/tvm-discord-email-verification"

ENV NODE_ENV=production
WORKDIR /usr/app
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p config && chown node:node config
COPY --from=dependencies /usr/app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ui-text.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node
CMD ["node", "src/tvm/index.js"]
