/**
 * Cách ly tenant ở tầng kiểu dữ liệu — SECURITY.md §4 lớp L2.
 *
 * Rủi ro R6 (rò rỉ dữ liệu chéo workspace) là loại lỗ hổng dễ mắc nhất trong
 * ứng dụng multi-tenant, và nó thường xảy ra theo đúng một kiểu: ai đó viết
 * `prisma.contentPost.findUnique({ where: { id } })` mà quên mất workspaceId.
 *
 * Các helper dưới đây làm cho việc quên đó trở thành LỖI BIÊN DỊCH thay vì lỗ
 * hổng bảo mật im lặng.
 */

/** Ngữ cảnh tenant — bắt buộc truyền vào mọi method của repository nghiệp vụ. */
export interface TenantContext {
  readonly workspaceId: string;
}

export class MissingTenantScopeError extends Error {
  constructor(operation: string) {
    super(
      `Truy vấn "${operation}" thiếu workspaceId. Mọi truy vấn dữ liệu nghiệp vụ phải giới hạn theo workspace (SECURITY.md §4).`,
    );
    this.name = 'MissingTenantScopeError';
  }
}

/**
 * Bọc điều kiện `where` với workspaceId.
 *
 * Kiểu trả về ép workspaceId luôn có mặt, nên `prisma.post.findMany({ where:
 * scopedWhere(ctx, { status }) })` không thể biên dịch nếu thiếu ngữ cảnh.
 */
export function scopedWhere<T extends Record<string, unknown>>(
  ctx: TenantContext,
  where: T = {} as T,
): T & { workspaceId: string } {
  if (!ctx?.workspaceId) {
    throw new MissingTenantScopeError('scopedWhere');
  }
  return { ...where, workspaceId: ctx.workspaceId };
}

/**
 * Điều kiện cho bảng có xóa mềm: mặc định loại bỏ bản ghi đã xóa.
 *
 * Truyền `includeDeleted: true` một cách tường minh khi thật sự cần — việc phải
 * viết ra ý định đó khiến người review nhìn thấy được.
 */
export function activeScopedWhere<T extends Record<string, unknown>>(
  ctx: TenantContext,
  where: T = {} as T,
  options: { includeDeleted?: boolean } = {},
): T & { workspaceId: string; deletedAt?: null } {
  const scoped = scopedWhere(ctx, where);
  return options.includeDeleted ? scoped : { ...scoped, deletedAt: null };
}

/**
 * Tìm theo ID nhưng vẫn giới hạn trong workspace.
 *
 * Trả về `null` (chứ không phải ném lỗi) khi bản ghi thuộc workspace khác —
 * caller sẽ chuyển thành 404. Trả 403 sẽ tiết lộ rằng bản ghi đó CÓ TỒN TẠI,
 * đủ để dò ID của tenant khác (SECURITY.md §4 lớp L5).
 */
export function scopedById(ctx: TenantContext, id: string): { id: string; workspaceId: string } {
  if (!ctx?.workspaceId) {
    throw new MissingTenantScopeError('scopedById');
  }
  return { id, workspaceId: ctx.workspaceId };
}
