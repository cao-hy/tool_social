# Build từ thư mục gốc của repo:
#   docker build -f docker/web.Dockerfile -t socialhub-web .
#
# Chỉ cần khi KHÔNG deploy frontend lên Vercel.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN npm ci --ignore-scripts

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Biến NEXT_PUBLIC_* được nhúng vào bundle LÚC BUILD, không phải lúc chạy.
# Vì vậy chúng phải là build arg. Tuyệt đối không truyền secret qua đây —
# mọi thứ nhúng vào bundle đều công khai với người dùng (SECURITY.md §10).
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_APP_NAME="SocialHub Manager"
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME

RUN npm run build -w @socialhub/shared && npm run build -w @socialhub/web

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# Chế độ standalone của Next chỉ đóng gói đúng những file cần chạy —
# image nhỏ hơn nhiều so với copy toàn bộ node_modules.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
