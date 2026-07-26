import { Controller, Get } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPlatformError } from '@socialhub/platform-adapters';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { AppError } from '../common/errors/app-error';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { attachRequestId } from '../common/request-context';

@Controller('test-errors')
class TestErrorsController {
  @Get('not-found')
  notFound(): never {
    throw AppError.notFound('bài đăng');
  }

  @Get('forbidden')
  forbidden(): never {
    throw AppError.forbidden();
  }

  @Get('capability')
  capability(): never {
    throw AppError.capabilityUnsupported('PINTEREST', 'replyToComment');
  }

  @Get('zod')
  zod(): never {
    z.object({ email: z.string().email() }).parse({ email: 'khong-phai-email' });
    throw new Error('unreachable');
  }

  @Get('platform-rate-limit')
  platformRateLimit(): never {
    throw createPlatformError('RATE_LIMITED', 'FACEBOOK', 'Vượt quota', {
      retryAfterMs: 60_000,
    });
  }

  @Get('platform-auth')
  platformAuth(): never {
    throw createPlatformError('AUTH_INVALID', 'YOUTUBE', 'Token đã bị thu hồi');
  }

  @Get('leaky-secret')
  leakySecret(): never {
    // Mô phỏng error message từ platform API có nhúng token — chuyện thật sự
    // xảy ra khi nền tảng echo lại request đã gửi.
    throw new AppError(
      'PLATFORM_ERROR',
      'Request failed: access_token=EAAGsecret123456789 is invalid',
    );
  }

  @Get('unexpected')
  unexpected(): never {
    throw new TypeError("Cannot read properties of undefined (reading 'workspaceId')");
  }
}

describe('AllExceptionsFilter (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestErrorsController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', (req, reply, done) => {
        attachRequestId(req, reply);
        done();
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('AppError.notFound → 404 với mã lỗi nghiệp vụ', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/not-found').expect(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('bài đăng');
  });

  it('AppError.forbidden → 403', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/forbidden').expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('capability không hỗ trợ → 403 CAPABILITY_UNSUPPORTED kèm ngữ cảnh', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/capability').expect(403);
    expect(response.body.error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(response.body.error.details.platform).toBe('PINTEREST');
    expect(response.body.error.details.capability).toBe('replyToComment');
  });

  it('ZodError → 400 kèm danh sách trường sai', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/zod').expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].field).toBe('email');
  });

  it('PlatformError RATE_LIMITED → 429', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-errors/platform-rate-limit')
      .expect(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
    expect(response.body.error.details.retryable).toBe(true);
  });

  it('PlatformError AUTH_INVALID → 409 ACCOUNT_DISCONNECTED (cần kết nối lại)', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-errors/platform-auth')
      .expect(409);
    expect(response.body.error.code).toBe('ACCOUNT_DISCONNECTED');
    expect(response.body.error.details.retryable).toBe(false);
  });

  it('SECRET TRONG THÔNG ĐIỆP LỖI BỊ CHE TRƯỚC KHI TRẢ VỀ CLIENT', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/leaky-secret');
    expect(JSON.stringify(response.body)).not.toContain('EAAGsecret123456789');
    expect(response.body.error.message).toContain('[REDACTED]');
  });

  it('lỗi không lường trước → 500 và KHÔNG lộ chi tiết nội bộ', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/unexpected').expect(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.message).not.toContain('workspaceId');
    expect(response.body.error.message).not.toContain('TypeError');
    expect(JSON.stringify(response.body)).not.toContain('at Object');
  });

  it('mọi response lỗi đều có requestId để đối chiếu với log', async () => {
    for (const path of ['not-found', 'forbidden', 'unexpected']) {
      const response = await request(app.getHttpServer()).get(`/test-errors/${path}`);
      expect(response.body.meta.requestId).toBeTruthy();
      expect(response.body.meta.timestamp).toBeTruthy();
    }
  });
});
