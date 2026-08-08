import type { AdapterRegistry } from '@socialhub/platform-adapters';
import type { PreparedProxyContext } from '@socialhub/config';

export interface WorkspaceAdapterContext {
  adapters: AdapterRegistry;
  proxy: PreparedProxyContext;
  release(): Promise<void>;
}

export interface WorkspacePlatformResolver {
  withWorkspace<T>(
    workspaceId: string,
    fn: (ctx: WorkspaceAdapterContext) => Promise<T>,
  ): Promise<T>;
}
