import { Inject, Injectable } from '@nestjs/common';
import {
  createProxyAwareFetch,
  resolveWorkspaceProxyConfig,
  checkProxyAwareNetwork,
} from '@socialhub/config';
import {
  AdapterRegistry,
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
} from '@socialhub/platform-adapters';
import {
  decryptToken,
  ProxyPolicyService,
  RedisProxyPolicyCache,
  ProxyEndpointValidator,
  type Keyring,
  type ProxyAttestation,
} from '@socialhub/security';
import { type ProxyConfig } from '@socialhub/shared';
import dns from 'node:dns/promises';
import { ProxyDispatcherPool } from '@socialhub/config';

export interface WorkspaceAdapterContext {
  adapters: AdapterRegistry;
  workspaceId: string;
  proxyConfigVersion: number;
  proxyFingerprint: string | null;
  attestation: ProxyAttestation | null;
  createdAt: number;
}
import { ENV, type ApiEnv } from './env.provider';
import { PrismaService } from './prisma/prisma.service';
import { KEYRING } from './tokens';
import { RedisService } from './redis/redis.service';

@Injectable()
export class AdapterRegistryFactory {
  private readonly policyService: ProxyPolicyService;
  private readonly endpointValidator: ProxyEndpointValidator;
  private readonly dispatcherPool: ProxyDispatcherPool;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {
    this.policyService = new ProxyPolicyService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new RedisProxyPolicyCache(this.redisService.getClient() as any),
    );
    this.endpointValidator = new ProxyEndpointValidator(dns);
    this.dispatcherPool = new ProxyDispatcherPool();
  }

  async forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> {
    const setting = await this.prisma.workspaceProxySetting.findUnique({
      where: { workspaceId },
    });

    const proxyConfig = resolveWorkspaceProxyConfig(setting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );

    let attestation: ProxyAttestation | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dispatcherLease: any = undefined; // Using any here to bypass type error if imported from wrong place
    // Actually we can import it from config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configVersion = (setting as any)?.configVersion ?? 0;

    if (proxyConfig.enabled && proxyConfig.proxyUrl) {
      const validatedEndpoint = await this.endpointValidator.validate(proxyConfig.proxyUrl);
      dispatcherLease = await this.dispatcherPool.acquire(validatedEndpoint);

      attestation = await this.policyService.getAttestation(
        workspaceId,
        proxyConfig,
        configVersion,
        async () => {
          return await checkProxyAwareNetwork(
            proxyConfig,
            createProxyAwareFetch(proxyConfig, dispatcherLease),
          );
        },
      );

      // Before caching/returning, check version again
      const currentSetting = await this.prisma.workspaceProxySetting.findUnique({
        where: { workspaceId },
        select: { configVersion: true },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((currentSetting as any)?.configVersion !== configVersion) {
        dispatcherLease.release();
        throw new Error('Proxy configuration changed during request');
      }
    }

    return {
      adapters: this.createInternal(proxyConfig, dispatcherLease),
      workspaceId,
      proxyConfigVersion: configVersion,
      proxyFingerprint: null, // we will add this in phase 2 when we inject fingerprint secret
      attestation,
      createdAt: Date.now(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createInternal(proxyConfig?: ProxyConfig, dispatcherLease?: any): AdapterRegistry {
    const env = this.env;
    return createRuntimeAdapterRegistry({
      nodeEnv: env.NODE_ENV,
      fetch: createProxyAwareFetch(proxyConfig, dispatcherLease),
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
      pinterest: {
        appId: env.PINTEREST_APP_ID,
        appSecret: env.PINTEREST_APP_SECRET,
        defaultBoardName: env.PINTEREST_DEFAULT_BOARD_NAME,
        environment: env.PINTEREST_API_ENVIRONMENT,
      },
      youtube: {
        clientId: env.YOUTUBE_CLIENT_ID,
        clientSecret: env.YOUTUBE_CLIENT_SECRET,
      },
      tiktok: {
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        scopes: [...TIKTOK_OAUTH_SCOPES],
      },
    });
  }
}
