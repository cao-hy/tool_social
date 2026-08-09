import {
  ProxyEndpointValidator,
  type ProxyPolicyService,
  type ProxyAttestation,
} from '@socialhub/security';
import {
  ProxyDispatcherPool,
  type ProxyDispatcherHandle,
  UnsupportedProxyProtocolError,
} from './proxy-dispatcher-pool';
import {
  checkProxyAwareNetwork,
  createProxiedFetch,
  resolveWorkspaceProxyConfig,
  ProxyConfigurationChangedError,
  ProxyConfigurationMissingError,
} from './proxy';
import type { ProxyConfig, SocialEgressPolicy } from '@socialhub/shared';
import type { WorkspaceProxySettingRecord } from './proxy';
import dns from 'node:dns/promises';

export interface PreparedProxyContext {
  enabled: boolean;
  egressPolicy: SocialEgressPolicy;
  config: ProxyConfig;
  configVersion: number;
  routeFingerprint: string | null;
  attestation: ProxyAttestation | null;
  dispatcherHandle?: ProxyDispatcherHandle;
}

export class ProxyRuntimeService {
  private endpointValidator: ProxyEndpointValidator;
  private dispatcherPool: ProxyDispatcherPool;

  constructor(
    private readonly policyService: ProxyPolicyService,
    private readonly fingerprintSecret: string,
  ) {
    this.endpointValidator = new ProxyEndpointValidator(dns);
    this.dispatcherPool = new ProxyDispatcherPool(this.fingerprintSecret);
  }

  async prepareWorkspace(
    workspaceId: string,
    getWorkspaceSetting: (workspaceId: string) => Promise<WorkspaceProxySettingRecord | null>,
    decryptProxyUrl: (ciphertext: string) => string,
    options?: {
      forceAttestation?: boolean;
      getWorkspaceConfigVersion?: (workspaceId: string) => Promise<number | null>;
      getWorkspaceEgressPolicy?: (workspaceId: string) => Promise<SocialEgressPolicy | null>;
    },
  ): Promise<PreparedProxyContext> {
    const [setting, durablePolicy] = await Promise.all([
      getWorkspaceSetting(workspaceId),
      options?.getWorkspaceEgressPolicy?.(workspaceId),
    ]);
    const egressPolicy = durablePolicy ?? 'DIRECT_ALLOWED';

    if (egressPolicy === 'PROXY_REQUIRED' && (!setting || !setting.enabled)) {
      throw new ProxyConfigurationMissingError(
        'Workspace policy requires proxy egress, but no enabled workspace proxy is configured.',
      );
    }

    const proxyConfig = resolveWorkspaceProxyConfig(setting, decryptProxyUrl);

    if (egressPolicy === 'PROXY_REQUIRED' && !proxyConfig.enabled) {
      throw new ProxyConfigurationMissingError(
        'Workspace policy requires proxy egress, but resolved proxy config is disabled.',
      );
    }

    let attestation: ProxyAttestation | null = null;
    let dispatcherHandle: ProxyDispatcherHandle | undefined = undefined;
    const snapshotVersion = setting?.configVersion ?? 0;
    const verifySnapshotStillCurrent = async () => {
      const currentVersion = options?.getWorkspaceConfigVersion
        ? ((await options.getWorkspaceConfigVersion(workspaceId)) ?? 0)
        : ((await getWorkspaceSetting(workspaceId))?.configVersion ?? 0);
      if (currentVersion !== snapshotVersion) {
        throw new ProxyConfigurationChangedError(
          'Proxy configuration changed during request processing',
        );
      }
    };

    if (proxyConfig.enabled) {
      if (!proxyConfig.proxyUrl) {
        throw new ProxyConfigurationMissingError(
          'Proxy is enabled but no proxy URL is configured.',
        );
      }

      const validatedEndpoint = await this.endpointValidator.validate(proxyConfig.proxyUrl);
      if (validatedEndpoint.protocol.startsWith('socks')) {
        throw new UnsupportedProxyProtocolError('SOCKS proxy is temporarily disabled.');
      }

      const acquiredHandle = await this.dispatcherPool.acquire(validatedEndpoint);
      dispatcherHandle = acquiredHandle;

      try {
        const runAttestation = async (forceAttestation?: boolean) =>
          await this.policyService.getAttestation(
            workspaceId,
            proxyConfig,
            snapshotVersion,
            validatedEndpoint.gatewayAddresses,
            async () => {
              const fetchImpl = createProxiedFetch(
                { ...proxyConfig, enabled: true, proxyUrl: proxyConfig.proxyUrl as string },
                acquiredHandle,
              );
              return await checkProxyAwareNetwork(proxyConfig, fetchImpl);
            },
            forceAttestation,
          );

        attestation = await runAttestation(options?.forceAttestation);

        // Before returning context, verify that the setting hasn't changed.
        await verifySnapshotStillCurrent();
      } catch (err) {
        dispatcherHandle.release();
        throw err;
      }
    }

    return {
      enabled: proxyConfig.enabled,
      egressPolicy,
      config: proxyConfig,
      configVersion: snapshotVersion,
      routeFingerprint: attestation?.proxyFingerprint ?? null,
      attestation,
      dispatcherHandle,
    };
  }

  async closeAll(): Promise<void> {
    await this.dispatcherPool.closeAll();
  }
}
