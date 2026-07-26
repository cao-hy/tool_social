import { z } from 'zod';

/** Vai trò trong workspace — prompt §5 Module 2. */
export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'ANALYST', 'VIEWER'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);

/**
 * Thứ bậc vai trò. Số lớn hơn = quyền cao hơn.
 *
 * Lưu ý: thứ bậc này KHÔNG đủ để quyết định mọi quyền. ANALYST và VIEWER đều
 * "chỉ đọc" nhưng ANALYST được xem analytics chi tiết hơn; còn EDITOR có quyền
 * ghi nội dung nhưng KHÔNG có quyền quản trị. Vì vậy quyền thật được tra trong
 * PERMISSIONS bên dưới, thứ bậc chỉ dùng cho các so sánh đơn giản
 * (ví dụ: "không được đổi vai trò của người ngang hoặc cao hơn mình").
 */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  VIEWER: 1,
  ANALYST: 2,
  EDITOR: 3,
  ADMIN: 4,
  OWNER: 5,
};

export const PERMISSIONS = [
  'workspace:view',
  'workspace:update',
  'workspace:delete',
  'workspace:transfer_ownership',
  'member:view',
  'member:invite',
  'member:remove',
  'member:change_role',
  'social_account:view',
  'social_account:connect',
  'social_account:disconnect',
  'post:view',
  'post:create',
  'post:update',
  'post:delete',
  'post:publish',
  'post:schedule',
  'media:view',
  'media:upload',
  'media:delete',
  'comment:view',
  'comment:reply',
  'comment:moderate',
  'comment:assign',
  'analytics:view',
  'audit_log:view',
  'notification:view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const permissionSchema = z.enum(PERMISSIONS);

const VIEWER_PERMISSIONS: readonly Permission[] = [
  'workspace:view',
  'member:view',
  'social_account:view',
  'post:view',
  'media:view',
  'comment:view',
  'analytics:view',
  'notification:view',
];

const ANALYST_PERMISSIONS: readonly Permission[] = [...VIEWER_PERMISSIONS];

const EDITOR_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  'post:create',
  'post:update',
  'post:delete',
  'post:publish',
  'post:schedule',
  'media:upload',
  'media:delete',
  'comment:reply',
  'comment:assign',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...EDITOR_PERMISSIONS,
  'workspace:update',
  'member:invite',
  'member:remove',
  'member:change_role',
  'social_account:connect',
  'social_account:disconnect',
  'comment:moderate',
  'audit_log:view',
];

const OWNER_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  'workspace:delete',
  'workspace:transfer_ownership',
];

export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly Permission[]> = {
  VIEWER: VIEWER_PERMISSIONS,
  ANALYST: ANALYST_PERMISSIONS,
  EDITOR: EDITOR_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  OWNER: OWNER_PERMISSIONS,
};

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasAllPermissions(
  role: WorkspaceRole,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/**
 * Ai được phép đặt vai trò nào cho ai (SECURITY.md §4).
 *
 *  1. Không ai được đổi vai trò của chính mình — chống tự leo thang.
 *  2. Không được đụng vào người có quyền ngang hoặc cao hơn mình.
 *  3. Không được phong ai lên mức ngang hoặc cao hơn chính mình.
 *
 * Hệ quả của luật 3: hàm này KHÔNG BAO GIỜ trả `true` cho `targetNewRole =
 * 'OWNER'`, kể cả khi người thực hiện là OWNER. Chuyển quyền sở hữu là một
 * thao tác riêng (`workspace:transfer_ownership`) vì nó đồng thời hạ cấp OWNER
 * hiện tại — gộp chung vào đây sẽ tạo ra tình huống workspace có hai OWNER hoặc
 * không có OWNER nào.
 */
export function canAssignRole(input: {
  actorRole: WorkspaceRole;
  targetCurrentRole: WorkspaceRole;
  targetNewRole: WorkspaceRole;
  isSelf: boolean;
}): boolean {
  const { actorRole, targetCurrentRole, targetNewRole, isSelf } = input;

  if (isSelf) return false;
  if (!hasPermission(actorRole, 'member:change_role')) return false;
  if (ROLE_RANK[targetCurrentRole] >= ROLE_RANK[actorRole]) return false;
  if (ROLE_RANK[targetNewRole] >= ROLE_RANK[actorRole]) return false;

  return true;
}
