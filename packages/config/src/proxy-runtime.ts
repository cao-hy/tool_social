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
  ProxyConfigurationError,
} from './proxy';
import type { ProxyConfig } from '@socialhub/shared';
import type { WorkspaceProxySettingRecord } from './proxy';
import dns from 'node:dns/promises';

import type { AdapterRegistry } from '@socialhub/platform-adapters';

export interface PreparedProxyContext {
  enabled: boolean;
  config: ProxyConfig;
  configVersion: number;
  routeFingerprint: string | null;
  attestation: ProxyAttestation | null;
  dispatcherHandle?: ProxyDispatcherHandle;
}

export interface WorkspaceAdapterContext {
  adapters: AdapterRegistry;
  proxy: PreparedProxyContext;
  release(): Promise<void>;
}

export interface WorkspacePlatformResolver {
  forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext>;
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
    options?: { forceAttestation?: boolean },
  ): Promise<PreparedProxyContext> {
    const setting = await getWorkspaceSetting(workspaceId);
    const proxyConfig = resolveWorkspaceProxyConfig(setting, decryptProxyUrl);

    let attestation: ProxyAttestation | null = null;
    let dispatcherHandle: ProxyDispatcherHandle | undefined = undefined;
    const snapshotVersion = setting?.configVersion ?? 0;

    if (proxyConfig.enabled) {
      if (!proxyConfig.proxyUrl) {
        throw new ProxyConfigurationError('Proxy is enabled but no proxy URL is configured.');
      }

      const validatedEndpoint = await this.endpointValidator.validate(proxyConfig.proxyUrl);
      if (validatedEndpoint.protocol.startsWith('socks')) {
        throw new UnsupportedProxyProtocolError('SOCKS proxy is temporarily disabled.');
      }

      const acquiredHandle = await this.dispatcherPool.acquire(validatedEndpoint);
      dispatcherHandle = acquiredHandle;

      try {
        attestation = await this.policyService.getAttestation(
          workspaceId,
          proxyConfig,
          snapshotVersion,
          async () => {
            const fetchImpl = createProxiedFetch(
              { ...proxyConfig, enabled: true, proxyUrl: proxyConfig.proxyUrl as string },
              acquiredHandle,
            );
            return await checkProxyAwareNetwork(proxyConfig, fetchImpl);
          },
          options?.forceAttestation,
        );

        // Before returning context, verify that the setting hasn't changed.
        const currentSetting = await getWorkspaceSetting(workspaceId);
        if ((currentSetting?.configVersion ?? 0) !== snapshotVersion) {
          throw new ProxyConfigurationError(
            'Proxy configuration changed during request processing',
          );
        }
      } catch (err) {
        dispatcherHandle.release();
        throw err;
      }
    }

    return {
      enabled: proxyConfig.enabled,
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
