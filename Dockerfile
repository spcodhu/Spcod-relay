# syntax=docker/dockerfile:1
# Spcode Relay —— 零知识哑中继（单文件多阶段构建）
# 构建：docker build -t spcode-relay apps/relay（或以 apps/relay 为上下文）
# 运行：docker run -p 8787:8787 spcode-relay

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 可选：挂载 PWA 构建产物 → -v $(pwd)/public:/app/public:ro
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
