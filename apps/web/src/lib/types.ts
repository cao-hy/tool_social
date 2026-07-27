import type { WorkspaceRole } from '@socialhub/shared';

export interface UserView {
  id: string;
  email: string;
  name: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: WorkspaceRole;
}

export interface AuthPayload {
  user: UserView;
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  expiresAt: string;
  devInvitationToken?: string;
  resent?: boolean;
}

export interface AuditLogItem {
  id: string;
  action: string;
  actorUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
}
