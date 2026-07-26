import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@socialhub/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module';
import { attachRequestId } from './common/request-context';

export const API_PREFIX = 'api/v1';

/**
 * Đường dẫn KHÔNG nằm dưới /api/v1.
 *
 * Health/readiness phục vụ orchestrator, không phục vụ client — gắn version vào
 * chúng sẽ khiến mỗi lần lên v2 phải sửa cấu hình hạ tầng.
 */
const UNVERSIONED_ROUTES = ['health', 'ready'];

export async function createApp(env: ApiEnv): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: env.TRUST_PROXY,
      bodyLimit: 2 * 1024 * 1024,
      // Cần cho webhook: chữ ký được tính trên byte thô (SECURITY.md §6 bước 1).
      // Route webhook sẽ đăng ký content-type parser riêng ở Phase 3.
      genReqId: () => undefined as unknown as string,
    }),
    { bufferLogs: true },
  );

  app.setGlobalPrefix(API_PREFIX, { exclude: UNVERSIONED_ROUTES });

  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    attachRequestId(request, reply);
    done();
  });

  await app.register(fastifyHelmet, {
    // SECURITY.md §9. API trả JSON nên CSP ở đây chỉ là phòng thủ chiều sâu;
    // CSP thật sự quan trọng nằm ở apps/web.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(fastifyRateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Ở Phase 2 sẽ chuyển sang store Redis để có hiệu lực trên nhiều instance.
    // Store in-memory chỉ giới hạn được trong phạm vi một process.
    allowList: (request) => request.url === '/health' || request.url === '/ready',
  });

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id'],
  });

  // Chờ job đang chạy và đóng kết nối DB/Redis trước khi thoát.
  app.enableShutdownHooks();

  return app;
}
