import { platformSchema } from '@socialhub/shared';
import { z } from 'zod';

export const commentStatusSchema = z.enum(['OPEN', 'PENDING', 'RESOLVED']);

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

export const listCommentsQuerySchema = z.object({
  status: commentStatusSchema.optional(),
  platform: platformSchema.optional(),
  socialAccountId: z.string().min(1).optional(),
  assignedToId: z.string().min(1).optional(),
  tagId: z.string().min(1).optional(),
  q: optionalText,
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const updateCommentStatusSchema = z.object({
  status: commentStatusSchema,
});

export const assignCommentSchema = z.object({
  memberId: z.string().min(1).nullable(),
});

export const updateCommentTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(20),
});

export const createCommentTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6b7280'),
});

export const addCommentNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export const replyToCommentSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

export const createReplyTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(2000),
});

export const updateReplyTemplateSchema = createReplyTemplateSchema.partial();

export const syncCommentsSchema = z.object({
  socialAccountId: z.string().min(1),
  platformPostId: z.string().min(1).optional(),
  since: z.coerce.date().optional(),
});

export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
export type UpdateCommentStatusInput = z.infer<typeof updateCommentStatusSchema>;
export type AssignCommentInput = z.infer<typeof assignCommentSchema>;
export type UpdateCommentTagsInput = z.infer<typeof updateCommentTagsSchema>;
export type CreateCommentTagInput = z.infer<typeof createCommentTagSchema>;
export type AddCommentNoteInput = z.infer<typeof addCommentNoteSchema>;
export type ReplyToCommentInput = z.infer<typeof replyToCommentSchema>;
export type CreateReplyTemplateInput = z.infer<typeof createReplyTemplateSchema>;
export type UpdateReplyTemplateInput = z.infer<typeof updateReplyTemplateSchema>;
export type SyncCommentsInput = z.infer<typeof syncCommentsSchema>;
