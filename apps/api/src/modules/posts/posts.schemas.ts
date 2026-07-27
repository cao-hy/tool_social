import { platformSchema } from '@socialhub/shared';
import { z } from 'zod';

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

export const postComposerSchema = z.object({
  title: optionalText,
  body: optionalText,
  linkUrl: z
    .string()
    .trim()
    .url()
    .or(z.literal('').transform(() => undefined))
    .optional(),
  hashtags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  socialAccountIds: z.array(z.string().min(1)).max(20).default([]),
  mediaAssetIds: z.array(z.string().min(1)).max(10).default([]),
});

export const createPostSchema = postComposerSchema.extend({
  scheduledAt: z.coerce.date().optional(),
});

export const updatePostSchema = postComposerSchema.partial();

export const publishPostSchema = z.object({
  socialAccountIds: z.array(z.string().min(1)).max(20).optional(),
});

export const schedulePostSchema = publishPostSchema.extend({
  scheduledAt: z.coerce.date(),
});

export const listPostsQuerySchema = z.object({
  status: z
    .enum([
      'DRAFT',
      'SCHEDULED',
      'QUEUED',
      'PROCESSING',
      'PUBLISHED',
      'PARTIALLY_PUBLISHED',
      'FAILED',
      'CANCELLED',
    ])
    .optional(),
  platform: platformSchema.optional(),
  socialAccountId: z.string().min(1).optional(),
  q: optionalText,
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type PublishPostInputDto = z.infer<typeof publishPostSchema>;
export type SchedulePostInput = z.infer<typeof schedulePostSchema>;
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;
