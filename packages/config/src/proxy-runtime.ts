import {
  ProxyEndpointValidator,
  type ProxyPolicyService,
  type ProxyAttestation,
} from '@socialhub/security';
import { ProxyDispatcherPool, type ProxyDispatcherHandle } from './proxy-dispatcher-pool';
import {
  checkProxyAwareNetwork,
  createDirectFetch,
  createProxiedFetch,
  resolveWorkspaceProxyConfig,
} from './proxy';
import type { ProxyConfig } from '@socialhub/shared';
import type { WorkspaceProxySettingRecord } from './proxy';
import type { AdapterRegistry } from '@socialhub/platform-adapters';
import dns from 'node:dns/promises';

export interface WorkspaceAdapterContext {
  adapters: AdapterRegistry;
  proxy: {
    enabled: boolean;
    configVersion: number;
    fingerprint: string | null;
    attestation: ProxyAttestation | null;
  };
}

export interface PreparedProxyContext {
  config: ProxyConfig;
  configVersion: number;
  fingerprint: string | null;
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
  ): Promise<PreparedProxyContext> {
    const setting = await getWorkspaceSetting(workspaceId);
    const proxyConfig = resolveWorkspaceProxyConfig(setting, decryptProxyUrl);

    let attestation: ProxyAttestation | null = null;
    let dispatcherHandle: ProxyDispatcherHandle | undefined = undefined;
    const configVersion = setting?.configVersion ?? 0;

    if (proxyConfig.enabled && proxyConfig.proxyUrl) {
      const validatedEndpoint = await this.endpointValidator.validate(proxyConfig.proxyUrl);
      dispatcherHandle = await this.dispatcherPool.acquire(validatedEndpoint);

      attestation = await this.policyService.getAttestation(
        workspaceId,
        proxyConfig,
        configVersion,
        async () => {
          const fetchImpl = dispatcherHandle
            ? createProxiedFetch(
                { ...proxyConfig, enabled: true, proxyUrl: proxyConfig.proxyUrl as string },
                dispatcherHandle,
              )
            : createDirectFetch();
          return await checkProxyAwareNetwork(proxyConfig, fetchImpl);
        },
      );

      // Before caching/returning, verify that the setting hasn't changed.
      const currentSetting = await getWorkspaceSetting(workspaceId);
      if ((currentSetting?.configVersion ?? 0) !== configVersion) {
        throw new Error('Proxy configuration changed during request');
      }
    }

    return {
      config: proxyConfig,
      configVersion,
      fingerprint: attestation?.proxyFingerprint ?? null,
      attestation,
      dispatcherHandle,
    };
  }

  async closeAll() {
    this.dispatcherPool.closeAll();
  }
}
