import {
  getConfiguredProxyUrl,
  maskProxyUrl,
  normalizeProxyConfig,
  proxyConfigFromWorkspaceSetting,
  readProxyConfig,
} from '@socialhub/config';
import type { PrismaClientInstance } from '@socialhub/db';
import { decryptToken, type Keyring } from '@socialhub/security';
import type { ProxyConfig } from '@socialhub/shared';

export async function loadWorkspaceProxyConfig(
  prisma: PrismaClientInstance,
  keyring: Keyring,
  workspaceId: string,
): Promise<ProxyConfig> {
  const setting = await prisma.workspaceProxySetting.findUnique({ where: { workspaceId } });
  if (!setting) {
    const envProxyUrl = getConfiguredProxyUrl();
    return normalizeProxyConfig({
      ...readProxyConfig(),
      enabled: false,
      proxyUrl: envProxyUrl,
      proxyUrlMasked: maskProxyUrl(envProxyUrl),
      source: envProxyUrl ? 'ENV' : 'DIRECT',
    });
  }

  const config = proxyConfigFromWorkspaceSetting(setting, (ciphertext) =>
    decryptToken(ciphertext, keyring),
  );
  if (!config.proxyUrl) {
    const envProxyUrl = getConfiguredProxyUrl();
    return normalizeProxyConfig({
      ...config,
      proxyUrl: envProxyUrl,
      proxyUrlMasked: maskProxyUrl(envProxyUrl),
      source: envProxyUrl ? 'ENV' : 'DIRECT',
    });
  }
  return config;
}
