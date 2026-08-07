# Build từ thư mục gốc của repo:
#   docker build -f docker/worker.Dockerfile -t socialhub-worker .

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY packages/security/package.json ./packages/security/
COPY packages/db/package.json ./packages/db/
COPY packages/platform-adapters/package.json ./packages/platform-adapters/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
RUN npm ci --include=optional --ignore-scripts

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
RUN npm run build -w @socialhub/shared \
 && npm run build -w @socialhub/security \
 && npm run build -w @socialhub/platform-adapters \
 && npm run build -w @socialhub/config \
 && npx tsc -p packages/db/tsconfig.build.json \
 && npm run build -w @socialhub/worker
RUN npm prune --omit=dev --include=optional --ignore-scripts \
 && npm install --omit=dev --include=optional --ignore-scripts --os=linux --libc=musl --cpu=x64 sharp@0.35.3 \
 && node -e "require('sharp')"

FROM base AS runtime
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nodeapp

COPY --from=build --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/packages ./packages
COPY --from=build --chown=nodeapp:nodejs /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/worker/package.json ./apps/worker/
COPY --from=build --chown=nodeapp:nodejs /app/package.json ./

USER nodeapp

# Worker KHÔNG mở port public. Cổng này chỉ phục vụ health check nội bộ.
EXPOSE 4001

# STOPSIGNAL + thời gian chờ dài là bắt buộc: worker cần tới 30 giây để hoàn
# tất job đang chạy. Nếu orchestrator giết ngay, một job publish có thể bị cắt
# ngang SAU khi đã gọi API nền tảng nhưng TRƯỚC khi lưu externalPostId — dẫn
# thẳng tới đăng trùng ở lần retry (rủi ro R9).
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/worker/dist/main.js"]
