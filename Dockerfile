# syntax=docker/dockerfile:1
# Override if Docker Hub rate-limits you, e.g. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine
ARG NODE_IMAGE=node:22-alpine

# ---- build: compile the API and the dashboard ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

# ---- runtime: node + compiled output + production deps only ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
