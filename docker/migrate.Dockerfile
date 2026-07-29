# Chạy migration production bằng container tạm thời:
#   docker compose -f docker/docker-compose.prod.yml --profile tools run --rm migrate

FROM node:22-alpine
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

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

COPY packages/db/prisma ./packages/db/prisma

CMD ["npx", "prisma", "migrate", "deploy", "--schema", "packages/db/prisma/schema.prisma"]
