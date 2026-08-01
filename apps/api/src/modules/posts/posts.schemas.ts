import {
  countGraphemes,
  normalizeHashtag,
  normalizeOptionalSocialText,
  platformSchema,
} from '@socialhub/shared';
import { z } from 'zod';

const optionalText = z
  .string()
  .transform((value) => normalizeOptionalSocialText(value))
  .optional();

const hashtagSchema = z
  .string()
  .transform((value) => normalizeHashtag(value))
  .refine((value) => value.length > 0, 'Hashtag không được rỗng.')
  .refine((value) => countGraphemes(value) <= 80, 'Hashtag tối đa 80 ký tự.');

const optionalUrl = z
  .string()
  .trim()
  .url()
  .or(z.literal('').transform(() => undefined))
  .optional();

const platformOverrideSchema = z.object({
  socialAccountId: z.string().min(1),
  caption: optionalText,
  title: optionalText,
  description: optionalText,
  linkUrl: optionalUrl,
  mediaAssetIds: z.array(z.string().min(1)).max(10).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const postComposerSchema = z.object({
  title: optionalText,
  body: optionalText,
  linkUrl: optionalUrl,
  hashtags: z.array(hashtagSchema).max(30).default([]),
  socialAccountIds: z.array(z.string().min(1)).max(20).default([]),
  mediaAssetIds: z.array(z.string().min(1)).max(10).default([]),
  platformOverrides: z.array(platformOverrideSchema).max(20).default([]),
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

export const deletePostQuerySchema = z.object({
  deleteFromPlatforms: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default('true'),
  platformPostIds: z
    .string()
    .trim()
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .optional(),
});

export const bulkDeletePostsSchema = z.object({
  postIds: z.array(z.string().min(1)).min(1).max(100),
  deleteFromPlatforms: z.boolean().default(false),
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
export type DeletePostQuery = z.infer<typeof deletePostQuerySchema>;
export type BulkDeletePostsInput = z.infer<typeof bulkDeletePostsSchema>;
