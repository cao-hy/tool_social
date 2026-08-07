# Build từ thư mục gốc của repo:
#   docker build -f docker/api.Dockerfile -t socialhub-api .

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ---------------------------------------------------------------- deps
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
# Bỏ qua husky: git hook không có ý nghĩa gì bên trong image.
RUN npm ci --include=optional --ignore-scripts

# ---------------------------------------------------------------- build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
RUN npm run build -w @socialhub/shared \
 && npm run build -w @socialhub/security \
 && npm run build -w @socialhub/platform-adapters \
 && npm run build -w @socialhub/config \
 && npm run build -w @socialhub/social-runtime \
 && npx tsc -p packages/db/tsconfig.build.json \
 && npm run build -w @socialhub/api
RUN npm prune --omit=dev --include=optional --ignore-scripts \
 && npm install --omit=dev --include=optional --ignore-scripts --os=linux --libc=musl --cpu=x64 sharp@0.35.3 \
 && node -e "require('sharp')"

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production

# Chạy bằng user không phải root — nếu có lỗ hổng RCE, kẻ tấn công không lập
# tức có quyền root trong container.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nodeapp

COPY --from=build --chown=nodeapp:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/packages ./packages
COPY --from=build --chown=nodeapp:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=nodeapp:nodejs /app/package.json ./

USER nodeapp
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
