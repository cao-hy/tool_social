import { resolveWorkspaceProxyConfig } from '@socialhub/config';
import type { PrismaClientInstance } from '@socialhub/db';
import { decryptToken, type Keyring } from '@socialhub/security';
import type { ProxyConfig } from '@socialhub/shared';

export async function loadWorkspaceProxyConfig(
  prisma: PrismaClientInstance,
  keyring: Keyring,
  workspaceId: string,
): Promise<ProxyConfig> {
  const setting = await prisma.workspaceProxySetting.findUnique({
    where: { workspaceId },
  });

  return resolveWorkspaceProxyConfig(setting, (ciphertext) => decryptToken(ciphertext, keyring));
}
