import { z } from 'zod';

export const instagramTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});
export type InstagramTokenResponse = z.infer<typeof instagramTokenResponseSchema>;

export const instagramPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  access_token: z.string(),
  instagram_business_account: z
    .object({
      id: z.string(),
    })
    .optional(),
});
export type InstagramPage = z.infer<typeof instagramPageSchema>;

export const instagramPagesResponseSchema = z.object({
  data: z.array(instagramPageSchema),
});

export const instagramProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional(),
  profile_picture_url: z.string().optional(),
  followers_count: z.number().optional(),
});
export type InstagramProfile = z.infer<typeof instagramProfileSchema>;

export const instagramMediaContainerResponseSchema = z.object({
  id: z.string(),
});

export const instagramContainerStatusSchema = z.object({
  id: z.string().optional(),
  status_code: z.enum(['ERROR', 'EXPIRED', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED']).optional(),
  status: z.string().optional(),
});
export type InstagramContainerStatus = z.infer<typeof instagramContainerStatusSchema>;

export const instagramPublishResponseSchema = z.object({
  id: z.string(),
});

export const instagramSuccessResponseSchema = z.object({
  success: z.boolean().optional(),
});

export const instagramMediaSchema = z.object({
  id: z.string(),
  caption: z.string().optional(),
  media_type: z.string().optional(),
  media_url: z.string().optional(),
  permalink: z.string().optional(),
  thumbnail_url: z.string().optional(),
  timestamp: z.string().optional(),
  like_count: z.number().optional(),
  comments_count: z.number().optional(),
});
export type InstagramMedia = z.infer<typeof instagramMediaSchema>;

export const instagramMediaPageSchema = z.object({
  data: z.array(instagramMediaSchema),
  paging: z
    .object({
      cursors: z
        .object({
          after: z.string().optional(),
          before: z.string().optional(),
        })
        .optional(),
      next: z.string().optional(),
    })
    .optional(),
});
export type InstagramMediaPage = z.infer<typeof instagramMediaPageSchema>;

export const instagramInsightSchema = z.object({
  name: z.string(),
  values: z.array(
    z.object({
      value: z.unknown().optional(),
    }),
  ),
});

export const instagramInsightsResponseSchema = z.object({
  data: z.array(instagramInsightSchema),
});
export type InstagramInsightsResponse = z.infer<typeof instagramInsightsResponseSchema>;

export const instagramCommentSchema = z.object({
  id: z.string(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
  username: z.string().optional(),
  like_count: z.number().optional(),
  hidden: z.boolean().optional(),
});
export type InstagramComment = z.infer<typeof instagramCommentSchema>;

export const instagramCommentsPageSchema = z.object({
  data: z.array(instagramCommentSchema),
  paging: z
    .object({
      cursors: z
        .object({
          after: z.string().optional(),
          before: z.string().optional(),
        })
        .optional(),
      next: z.string().optional(),
    })
    .optional(),
});
export type InstagramCommentsPage = z.infer<typeof instagramCommentsPageSchema>;
