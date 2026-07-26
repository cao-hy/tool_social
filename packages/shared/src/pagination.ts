import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Phân trang offset — dùng cho bảng nhỏ, có tổng số. */
export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type OffsetPagination = z.infer<typeof offsetPaginationSchema>;

/**
 * Phân trang cursor — dùng cho danh sách lớn và danh sách có dữ liệu chèn liên
 * tục (comment, post). Offset sẽ nhảy/lặp bản ghi khi có bản ghi mới chèn vào
 * giữa hai lần gọi; cursor thì không.
 */
export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface OffsetPaginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function toOffsetPaginated<T>(
  items: T[],
  total: number,
  { page, pageSize }: OffsetPagination,
): OffsetPaginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');
export type SortOrder = z.infer<typeof sortOrderSchema>;

export const dateRangeSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((r) => r.from <= r.to, { message: '`from` phải nhỏ hơn hoặc bằng `to`' });

export type DateRange = z.infer<typeof dateRangeSchema>;

export const ANALYTICS_PRESETS = ['today', '7d', '30d', '90d', 'custom'] as const;
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];
export const analyticsPresetSchema = z.enum(ANALYTICS_PRESETS);
