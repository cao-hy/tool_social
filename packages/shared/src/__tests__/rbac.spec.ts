import { describe, expect, it } from 'vitest';
import {
  canAssignRole,
  hasPermission,
  ROLE_PERMISSIONS,
  WORKSPACE_ROLES,
  type Permission,
  type WorkspaceRole,
} from '../rbac';

describe('ma trận quyền (ARCHITECTURE.md §8.3)', () => {
  const cases: Array<[WorkspaceRole, Permission, boolean]> = [
    ['OWNER', 'workspace:delete', true],
    ['ADMIN', 'workspace:delete', false],
    ['ADMIN', 'workspace:transfer_ownership', false],
    ['ADMIN', 'social_account:connect', true],
    ['EDITOR', 'social_account:connect', false],
    ['EDITOR', 'post:publish', true],
    ['EDITOR', 'comment:reply', true],
    ['EDITOR', 'audit_log:view', false],
    ['ANALYST', 'analytics:view', true],
    ['ANALYST', 'post:create', false],
    ['ANALYST', 'comment:reply', false],
    ['VIEWER', 'post:view', true],
    ['VIEWER', 'post:create', false],
    ['VIEWER', 'analytics:view', true],
  ];

  it.each(cases)('%s → %s = %s', (role, permission, expected) => {
    expect(hasPermission(role, permission)).toBe(expected);
  });

  it('mọi vai trò đều xem được dữ liệu cơ bản của workspace', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(hasPermission(role, 'workspace:view')).toBe(true);
      expect(hasPermission(role, 'post:view')).toBe(true);
    }
  });

  it('chỉ OWNER có quyền hủy diệt workspace', () => {
    const owners = WORKSPACE_ROLES.filter((r) => hasPermission(r, 'workspace:delete'));
    expect(owners).toEqual(['OWNER']);
  });

  it('không vai trò nào có quyền ngoài danh sách đã khai báo', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(new Set(ROLE_PERMISSIONS[role]).size).toBe(ROLE_PERMISSIONS[role].length);
    }
  });
});

describe('canAssignRole — chống leo thang đặc quyền (SECURITY.md §4)', () => {
  it('không ai được đổi vai trò của chính mình', () => {
    expect(
      canAssignRole({
        actorRole: 'OWNER',
        targetCurrentRole: 'OWNER',
        targetNewRole: 'ADMIN',
        isSelf: true,
      }),
    ).toBe(false);
  });

  it('EDITOR không có quyền đổi vai trò của ai', () => {
    expect(
      canAssignRole({
        actorRole: 'EDITOR',
        targetCurrentRole: 'VIEWER',
        targetNewRole: 'ANALYST',
        isSelf: false,
      }),
    ).toBe(false);
  });

  it('ADMIN không được đụng vào OWNER', () => {
    expect(
      canAssignRole({
        actorRole: 'ADMIN',
        targetCurrentRole: 'OWNER',
        targetNewRole: 'VIEWER',
        isSelf: false,
      }),
    ).toBe(false);
  });

  it('ADMIN không được đụng vào ADMIN khác', () => {
    expect(
      canAssignRole({
        actorRole: 'ADMIN',
        targetCurrentRole: 'ADMIN',
        targetNewRole: 'VIEWER',
        isSelf: false,
      }),
    ).toBe(false);
  });

  it('ADMIN không được phong ai lên ADMIN (ngang mình)', () => {
    expect(
      canAssignRole({
        actorRole: 'ADMIN',
        targetCurrentRole: 'EDITOR',
        targetNewRole: 'ADMIN',
        isSelf: false,
      }),
    ).toBe(false);
  });

  it('ADMIN được đổi vai trò của EDITOR/ANALYST/VIEWER trong phạm vi thấp hơn mình', () => {
    expect(
      canAssignRole({
        actorRole: 'ADMIN',
        targetCurrentRole: 'VIEWER',
        targetNewRole: 'EDITOR',
        isSelf: false,
      }),
    ).toBe(true);
  });

  it('KHÔNG BAO GIỜ phong OWNER qua đường này — kể cả OWNER thực hiện', () => {
    for (const actorRole of WORKSPACE_ROLES) {
      expect(
        canAssignRole({
          actorRole,
          targetCurrentRole: 'VIEWER',
          targetNewRole: 'OWNER',
          isSelf: false,
        }),
      ).toBe(false);
    }
  });

  it('OWNER được đổi vai trò của ADMIN', () => {
    expect(
      canAssignRole({
        actorRole: 'OWNER',
        targetCurrentRole: 'ADMIN',
        targetNewRole: 'EDITOR',
        isSelf: false,
      }),
    ).toBe(true);
  });
});
