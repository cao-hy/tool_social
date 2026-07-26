import { Global, Module } from '@nestjs/common';
import { loadApiEnv } from '@socialhub/config';
import { AdapterRegistry } from '@socialhub/platform-adapters';
import { Keyring } from '@socialhub/security';
import { ENV, type ApiEnv } from './env.provider';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';

export const KEYRING = Symbol('KEYRING');
export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');

/**
 * Hạ tầng dùng chung: cấu hình, DB, Redis, keyring, adapter registry.
 *
 * `@Global` để không phải import lại ở mọi feature module. Đây là một trong số
 * rất ít chỗ nên dùng Global — nó chỉ chứa singleton hạ tầng, không chứa logic
 * nghiệp vụ.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): ApiEnv => loadApiEnv(),
    },
    {
      provide: KEYRING,
      inject: [ENV],
      useFactory: (env: ApiEnv): Keyring =>
        Keyring.fromEnv(env.ENCRYPTION_KEYS, env.ENCRYPTION_ACTIVE_KEY),
    },
    {
      // Registry rỗng ở Phase 1 — adapter thật được đăng ký từ Phase 3, sau khi
      // capability matrix được xác minh (docs/SOCIAL_API_CAPABILITIES.md).
      provide: ADAPTER_REGISTRY,
      useFactory: (): AdapterRegistry => new AdapterRegistry(),
    },
    PrismaService,
    RedisService,
  ],
  exports: [ENV, KEYRING, ADAPTER_REGISTRY, PrismaService, RedisService],
})
export class InfrastructureModule {}
