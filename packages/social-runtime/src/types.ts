import type { AdapterRegistry } from '@socialhub/platform-adapters';
import type { PreparedProxyContext } from '@socialhub/config';
import type { StoreProxyTarget } from '@socialhub/shared';

export interface WorkspaceRouteOptions {
  storeId?: string | null;
  target?: StoreProxyTarget;
}

export interface WorkspaceAdapterContext {
  adapters: AdapterRegistry;
  proxy: PreparedProxyContext;
  release(): Promise<void>;
}

export interface WorkspacePlatformResolver {
  withWorkspace<T>(
    workspaceId: string,
    fn: (ctx: WorkspaceAdapterContext) => Promise<T>,
    route?: WorkspaceRouteOptions,
  ): Promise<T>;
}
