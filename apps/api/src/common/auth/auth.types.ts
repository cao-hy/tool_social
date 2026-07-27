import type { WorkspaceRole } from '@socialhub/shared';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthenticatedRequest {
  user?: AuthenticatedUser;
  session?: {
    id: string;
    tokenHash: string;
  };
  membership?: {
    id: string;
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
  };
  params?: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}
