import { Global, Module } from '@nestjs/common';
import { loadApiEnv } from '@socialhub/config';
import { AdapterRegistry, createRuntimeAdapterRegistry } from '@socialhub/platform-adapters';
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
      provide: ADAPTER_REGISTRY,
      inject: [ENV],
      useFactory: (env: ApiEnv): AdapterRegistry =>
        createRuntimeAdapterRegistry({
          nodeEnv: env.NODE_ENV,
          facebook: {
            appId: env.FACEBOOK_APP_ID,
            appSecret: env.FACEBOOK_APP_SECRET,
            apiVersion: env.FACEBOOK_API_VERSION,
            loginConfigId: env.FACEBOOK_LOGIN_CONFIG_ID,
          },
          instagram: {
            appId: env.INSTAGRAM_APP_ID,
            appSecret: env.INSTAGRAM_APP_SECRET,
            apiVersion: env.FACEBOOK_API_VERSION,
          },
        }),
    },
    PrismaService,
    RedisService,
  ],
  exports: [ENV, KEYRING, ADAPTER_REGISTRY, PrismaService, RedisService],
})
export class InfrastructureModule {}
