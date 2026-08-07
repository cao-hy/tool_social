import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  CAPABILITY_MATRIX,
  getVerificationProgress,
  type PlatformCapabilityTable,
} from '@socialhub/platform-adapters';
import { PLATFORMS, type Capability, type Platform } from '@socialhub/shared';
import { Keyring } from '@socialhub/security';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { attachRequestId } from '../common/request-context';
import { HealthController } from '../modules/health/health.controller';
import { HealthService } from '../modules/health/health.service';
import { SystemController } from '../modules/health/system.controller';
import { AdapterRegistryFactory } from '../infrastructure/adapter-registry.factory';
import { PlatformsController } from '../modules/platforms/platforms.controller';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { ENV } from '../infrastructure/env.provider';
import { KEYRING } from '../infrastructure/tokens';
import { AuditService } from '../modules/audit/audit.service';

/**
 * Test HTTP thật (Supertest) nhưng thay Postgres/Redis bằng mock.
 *
 * Đây là lý do cụ thể để chọn NestJS (PROJECT_PLAN.md §5.1): thay dependency
 * bằng mock chỉ là một dòng `overrideProvider`. Kiểm chứng được hành vi
 * readiness khi database chết mà không cần thật sự làm chết một database.
 */
describe('Health & Platforms (e2e)', () => {
  let app: NestFastifyApplication;
  const prismaPing = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const redisPing = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController, PlatformsController, SystemController],
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: {
            ping: prismaPing,
            workspaceProxySetting: {
              findUnique: vi.fn().mockResolvedValue(null),
              update: vi.fn().mockResolvedValue(null),
              upsert: vi.fn().mockResolvedValue(null),
            },
          },
        },
        {
          provide: RedisService,
          useValue: { ping: redisPing, getClient: vi.fn().mockReturnValue({}) },
        },
        { provide: ENV, useValue: { SESSION_COOKIE_NAME: 'socialhub.sid' } },
        {
          provide: KEYRING,
          useValue: Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1'),
        },
        {
          provide: AdapterRegistryFactory,
          useValue: {
            forWorkspace: vi.fn().mockResolvedValue({
              adapters: { has: vi.fn() },
              proxy: {},
            }),
          },
        },
        { provide: AuditService, useValue: { record: vi.fn() } },
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

  afterEach(() => {
    // Reset cả hàng đợi `...Once` lẫn giá trị mặc định, nếu không một giá trị
    // `Once` chưa được tiêu thụ sẽ rò sang test sau.
    prismaPing.mockReset().mockResolvedValue(true);
    redisPing.mockReset().mockResolvedValue(true);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health (liveness)', () => {
    it('trả 200 khi process còn sống', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('VẪN trả 200 kể cả khi database chết — liveness không được giết container', async () => {
      prismaPing.mockResolvedValue(false);
      redisPing.mockResolvedValue(false);
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('liveness KHÔNG chạm vào database — đó là lý do nó vẫn 200', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
      expect(prismaPing).not.toHaveBeenCalled();
      expect(redisPing).not.toHaveBeenCalled();
    });

    it('không bọc envelope (orchestrator chỉ đọc status/JSON đơn giản)', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.body).not.toHaveProperty('success');
      expect(response.body).not.toHaveProperty('meta');
    });
  });

  describe('GET /ready (readiness)', () => {
    it('trả 200 khi mọi dependency khỏe mạnh', async () => {
      prismaPing.mockResolvedValue(true);
      redisPing.mockResolvedValue(true);

      const response = await request(app.getHttpServer()).get('/ready').expect(200);
      expect(response.body.ready).toBe(true);
      expect(response.body.checks.map((c: { name: string }) => c.name).sort()).toEqual([
        'postgres',
        'redis',
      ]);
    });

    it('trả 503 khi Postgres chết', async () => {
      prismaPing.mockResolvedValueOnce(false);
      const response = await request(app.getHttpServer()).get('/ready').expect(503);
      expect(response.body.ready).toBe(false);
      expect(
        response.body.checks.find((c: { name: string }) => c.name === 'postgres').healthy,
      ).toBe(false);
    });

    it('trả 503 khi Redis chết', async () => {
      prismaPing.mockResolvedValue(true);
      redisPing.mockResolvedValueOnce(false);
      await request(app.getHttpServer()).get('/ready').expect(503);
    });

    it('ping ném lỗi cũng thành not-ready, không thành 500', async () => {
      prismaPing.mockRejectedValueOnce(new Error('connection refused'));
      const response = await request(app.getHttpServer()).get('/ready').expect(503);
      expect(response.body.ready).toBe(false);
    });

    it('KHÔNG lộ chi tiết lỗi kết nối (có thể chứa connection string)', async () => {
      prismaPing.mockRejectedValueOnce(
        new Error('postgresql://user:supersecret@db:5432 connection refused'),
      );
      const response = await request(app.getHttpServer()).get('/ready').expect(503);
      expect(JSON.stringify(response.body)).not.toContain('supersecret');
      expect(JSON.stringify(response.body)).not.toContain('postgresql://');
    });
  });

  describe('X-Request-Id', () => {
    it('mọi response đều có header X-Request-Id', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.headers['x-request-id']).toBeTruthy();
    });

    it('tôn trọng X-Request-Id do client gửi lên (truy vết xuyên hệ thống)', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'trace-abc-123')
        .expect(200);
      expect(response.headers['x-request-id']).toBe('trace-abc-123');
    });
  });

  describe('GET /platforms/capabilities', () => {
    it('bọc trong envelope thống nhất', async () => {
      const response = await request(app.getHttpServer())
        .get('/platforms/capabilities')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.meta.requestId).toBeTruthy();
      expect(response.body.meta.timestamp).toBeTruthy();
    });

    it('trả capability của cả 5 nền tảng', async () => {
      const response = await request(app.getHttpServer()).get('/platforms/capabilities');
      const platforms = response.body.data.platforms.map((p: { platform: string }) => p.platform);
      expect(platforms.sort()).toEqual(['FACEBOOK', 'INSTAGRAM', 'PINTEREST', 'TIKTOK', 'YOUTUBE']);
    });

    it('báo cáo trung thực số capability đã xác minh (prompt §7)', async () => {
      const response = await request(app.getHttpServer()).get('/platforms/capabilities');
      expect(response.body.data.verificationProgress).toEqual(getVerificationProgress());
    });

    it('capability rời UNVERIFIED phải có nguồn, ngày và người xác minh', async () => {
      const response = await request(app.getHttpServer()).get('/platforms/capabilities');
      const responseByPlatform = Object.fromEntries(
        response.body.data.platforms.map((entry: { platform: Platform }) => [
          entry.platform,
          entry,
        ]),
      ) as Record<Platform, PlatformCapabilityTable>;

      for (const platform of PLATFORMS) {
        const expected = CAPABILITY_MATRIX[platform].capabilities;
        const actual = responseByPlatform[platform].capabilities;

        for (const [key, capability] of Object.entries(actual) as Array<
          [keyof typeof actual, Capability]
        >) {
          expect(capability.state).toBe(expected[key].state);
          if (capability.state === 'UNVERIFIED') continue;
          expect(capability.source).toMatch(/^https:\/\//);
          expect(capability.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(capability.verifiedBy).toBeTruthy();
        }
      }
    });

    it('công bố rõ các hành động bị chính sách dự án loại trừ (prompt §3)', async () => {
      const response = await request(app.getHttpServer()).get('/platforms/capabilities');
      const excluded = response.body.data.policyExcludedActions;
      expect(excluded.actions).toContain('likePost');
      expect(excluded.actions).toContain('sharePost');
      expect(excluded.reason).toContain('§3');
    });
  });

  describe('System proxy config', () => {
    it('không cho client chưa đăng nhập đọc network/proxy status', async () => {
      const response = await request(app.getHttpServer())
        .get('/workspaces/ws_1/system/network')
        .expect(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('không cho client chưa đăng nhập sửa proxy config', async () => {
      const response = await request(app.getHttpServer())
        .post('/workspaces/ws_1/system/proxy')
        .send({ enabled: true })
        .expect(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('404', () => {
    it('route không tồn tại trả envelope lỗi thống nhất', async () => {
      const response = await request(app.getHttpServer()).get('/khong-ton-tai').expect(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.meta.requestId).toBeTruthy();
    });
  });
});
