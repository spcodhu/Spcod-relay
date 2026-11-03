# syntax=docker/dockerfile:1
# 独立构建：docker build -t spcod-relay .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/index.js"]
