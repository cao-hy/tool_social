import {
  resolveWorkspaceProxyConfig,
  checkProxyAwareNetwork,
  createProxyAwareFetch,
} from '@socialhub/config';
import { ProxyPolicyService, RedisProxyPolicyCache } from '@socialhub/security';
import { decryptToken } from '@socialhub/security';
import type { PrismaClient } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import type { AdapterRegistry } from '@socialhub/platform-adapters';
import type { Redis } from 'ioredis';
import { type WorkerEnv } from '@socialhub/config';
import { createAdapterRegistry } from '../main';

export class WorkerAdapterFactory {
  private readonly policyService: ProxyPolicyService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keyring: Keyring,
    private readonly env: WorkerEnv,
    redisClient: Redis,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.policyService = new ProxyPolicyService(new RedisProxyPolicyCache(redisClient as any));
  }

  async forWorkspace(workspaceId: string): Promise<AdapterRegistry> {
    const setting = await this.prisma.workspaceProxySetting.findUnique({
      where: { workspaceId },
    });

    const proxyConfig = resolveWorkspaceProxyConfig(setting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );

    let pinnedIp: string | undefined;

    if (proxyConfig.enabled && proxyConfig.proxyUrl) {
      // Validate IP and get Attestation
      const attestation = await this.policyService.getAttestation(
        workspaceId,
        proxyConfig,
        setting?.updatedAt.getTime() ?? 0,
        async () => {
          return await checkProxyAwareNetwork(proxyConfig, createProxyAwareFetch(proxyConfig));
        },
      );
      pinnedIp = attestation.ip;
    }

    return createAdapterRegistry(this.env, proxyConfig, pinnedIp);
  }
}
