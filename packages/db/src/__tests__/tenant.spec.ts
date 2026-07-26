import { describe, expect, it } from 'vitest';
import { activeScopedWhere, MissingTenantScopeError, scopedById, scopedWhere } from '../tenant';

const ctx = { workspaceId: 'ws_1' };

describe('scopedWhere — cách ly tenant (SECURITY.md §4 lớp L2)', () => {
  it('luôn thêm workspaceId vào điều kiện', () => {
    expect(scopedWhere(ctx, { status: 'DRAFT' })).toEqual({
      status: 'DRAFT',
      workspaceId: 'ws_1',
    });
  });

  it('hoạt động với where rỗng', () => {
    expect(scopedWhere(ctx)).toEqual({ workspaceId: 'ws_1' });
  });

  it('KHÔNG cho phép caller ghi đè workspaceId để lách sang tenant khác', () => {
    const result = scopedWhere(ctx, { workspaceId: 'ws_khac' });
    expect(result.workspaceId).toBe('ws_1');
  });

  it('thiếu ngữ cảnh tenant → ném lỗi ngay, không âm thầm bỏ qua', () => {
    expect(() => scopedWhere({ workspaceId: '' }, {})).toThrow(MissingTenantScopeError);
  });
});

describe('activeScopedWhere — xóa mềm', () => {
  it('mặc định loại bỏ bản ghi đã xóa', () => {
    expect(activeScopedWhere(ctx, { status: 'DRAFT' })).toEqual({
      status: 'DRAFT',
      workspaceId: 'ws_1',
      deletedAt: null,
    });
  });

  it('chỉ bao gồm bản ghi đã xóa khi được yêu cầu tường minh', () => {
    const result = activeScopedWhere(ctx, {}, { includeDeleted: true });
    expect(result).not.toHaveProperty('deletedAt');
    expect(result.workspaceId).toBe('ws_1');
  });
});

describe('scopedById', () => {
  it('ghép id với workspaceId', () => {
    expect(scopedById(ctx, 'post_1')).toEqual({ id: 'post_1', workspaceId: 'ws_1' });
  });

  it('thiếu workspaceId → ném lỗi', () => {
    expect(() => scopedById({ workspaceId: '' }, 'post_1')).toThrow(MissingTenantScopeError);
  });
});
