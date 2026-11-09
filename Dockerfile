# syntax=docker/dockerfile:1
# 独立构建：docker build -t spcod-relay .
# 最终镜像同时包含 relay 与手机 PWA；PWA 源码固定到 Spcod 的明确提交，保证可复现。
ARG NODE_IMAGE=node:22-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org

# 把精确版本的 pnpm 安装到镜像层。Corepack 的缓存不会进入后续构建阶段，
# 直接安装可避免每个 RUN 再次从 npm registry 下载 pnpm。
FROM ${NODE_IMAGE} AS pnpm
ARG NPM_REGISTRY
RUN --mount=type=cache,id=spcod-npm,target=/root/.npm \
    npm_config_registry="${NPM_REGISTRY}" npm install --global --no-audit --no-fund pnpm@9.15.9

FROM pnpm AS pwa
ARG SPCOD_PWA_REPOSITORY=https://github.com/spcodhu/Spcode
ARG SPCOD_PWA_REF=490d5572935d46b3f7592d83c0aead329f89ff1b
ARG NPM_REGISTRY
WORKDIR /pwa
# 使用 Node 自带的 HTTPS 下载，避免额外安装 git/ca-certificates；超时后自动重试。
RUN node --input-type=module -e '\
import fs from "node:fs";\
const [url, output] = process.argv.slice(1);\
let lastError;\
for (let attempt = 1; attempt <= 4; attempt++) {\
  try {\
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });\
    if (!response.ok) throw new Error(`PWA source download failed: HTTP ${response.status}`);\
    fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));\
    lastError = null;\
    break;\
  } catch (error) {\
    lastError = error;\
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));\
  }\
}\
if (lastError) throw lastError;\
' "${SPCOD_PWA_REPOSITORY}/archive/${SPCOD_PWA_REF}.tar.gz" /tmp/spcod-pwa.tar.gz \
  && mkdir -p /pwa \
  && tar -xzf /tmp/spcod-pwa.tar.gz --strip-components=1 -C /pwa
RUN --mount=type=cache,id=spcod-pnpm-store,target=/root/.local/share/pnpm/store \
    npm_config_registry="${NPM_REGISTRY}" pnpm install --frozen-lockfile --filter @spcode/mobile...
RUN pnpm --filter @spcode/mobile build

FROM pnpm AS deps
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=spcod-pnpm-store,target=/root/.local/share/pnpm/store \
    npm_config_registry="${NPM_REGISTRY}" pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
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
