# syntax=docker/dockerfile:1
# 独立构建：docker build -t spcod-relay .
# 最终镜像同时包含 relay 与手机 PWA；PWA 源码固定到 Spcod 的明确提交，保证可复现。
FROM node:22-alpine AS pwa
ARG SPCOD_PWA_REPOSITORY=https://github.com/spcodhu/Spcode.git
ARG SPCOD_PWA_REF=1e8f4a9653edde0ae5e87585bd049b10b2f290a5
RUN apk add --no-cache ca-certificates git
RUN git init /pwa \
  && git -C /pwa remote add origin "${SPCOD_PWA_REPOSITORY}" \
  && git -C /pwa fetch --depth 1 origin "${SPCOD_PWA_REF}" \
  && git -C /pwa checkout --detach FETCH_HEAD
WORKDIR /pwa
RUN corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && pnpm install --frozen-lockfile --filter @spcode/mobile... \
  && pnpm --filter @spcode/mobile build

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
COPY --from=pwa /pwa/apps/mobile/dist ./public
COPY package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/index.js"]
