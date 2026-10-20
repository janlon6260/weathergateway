ARG NODE_IMAGE=node:24.22.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY shared ./shared
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd -g 10001 gateway && useradd -r -u 10001 -g 10001 gateway
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/web/dist ./web/dist
COPY --chown=10001:10001 server ./server
COPY --chown=10001:10001 shared ./shared
COPY --chown=10001:10001 scripts ./scripts
COPY --chown=10001:10001 deploy/broker-entrypoint.sh ./deploy/broker-entrypoint.sh
COPY --chown=10001:10001 package.json package-lock.json ./
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/health.js"]
CMD ["node", "server/index.js"]
