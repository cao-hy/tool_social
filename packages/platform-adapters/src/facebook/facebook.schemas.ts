import { z } from 'zod';

const pictureSchema = z
  .object({
    data: z
      .object({
        url: z.string().url().optional(),
      })
      .optional(),
  })
  .optional();

export const facebookTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

export type FacebookTokenResponse = z.infer<typeof facebookTokenResponseSchema>;

export const facebookPageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  access_token: z.string().min(1),
  tasks: z.array(z.string()).optional(),
  username: z.string().optional(),
  link: z.string().url().optional(),
  picture: pictureSchema,
});

export type FacebookPage = z.infer<typeof facebookPageSchema>;

export const facebookPagesResponseSchema = z.object({
  data: z.array(facebookPageSchema),
});

export const facebookPageProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  username: z.string().optional(),
  link: z.string().url().optional(),
  fan_count: z.number().int().nonnegative().optional(),
  picture: pictureSchema,
});

export type FacebookPageProfile = z.infer<typeof facebookPageProfileSchema>;

export const facebookPublishPostResponseSchema = z.object({
  id: z.string().min(1),
});

export type FacebookPublishPostResponse = z.infer<typeof facebookPublishPostResponseSchema>;

export const facebookPhotoUploadResponseSchema = z.object({
  id: z.string().min(1),
  post_id: z.string().min(1).optional(),
});

export type FacebookPhotoUploadResponse = z.infer<typeof facebookPhotoUploadResponseSchema>;

export const facebookCommentSchema = z.object({
  id: z.string().min(1),
  message: z.string().optional(),
  created_time: z.string().min(1),
  from: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      picture: pictureSchema,
    })
    .nullable()
    .optional(),
  like_count: z.number().int().nonnegative().optional(),
  parent: z
    .object({
      id: z.string().min(1),
    })
    .nullable()
    .optional(),
  is_hidden: z.boolean().optional(),
});

export type FacebookComment = z.infer<typeof facebookCommentSchema>;

export const facebookCommentsResponseSchema = z.object({
  data: z.array(facebookCommentSchema),
  paging: z
    .object({
      cursors: z
        .object({
          after: z.string().optional(),
        })
        .optional(),
      next: z.string().url().optional(),
    })
    .optional(),
});

export type FacebookCommentsResponse = z.infer<typeof facebookCommentsResponseSchema>;

export const facebookCommentReplyResponseSchema = z.object({
  id: z.string().min(1),
});

export type FacebookCommentReplyResponse = z.infer<typeof facebookCommentReplyResponseSchema>;

export const facebookMutationResponseSchema = z.object({
  success: z.boolean().optional(),
  id: z.string().min(1).optional(),
});

export type FacebookMutationResponse = z.infer<typeof facebookMutationResponseSchema>;

const facebookSummaryCountSchema = z
  .object({
    total_count: z.coerce.number().nonnegative().optional(),
  })
  .passthrough()
  .optional();

export const facebookPostEngagementSchema = z
  .object({
    reactions: z
      .object({
        summary: facebookSummaryCountSchema,
      })
      .passthrough()
      .optional(),
    comments: z
      .object({
        summary: facebookSummaryCountSchema,
      })
      .passthrough()
      .optional(),
    shares: z
      .object({
        count: z.coerce.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type FacebookPostEngagement = z.infer<typeof facebookPostEngagementSchema>;

export const facebookInsightsResponseSchema = z.object({
  data: z.array(
    z
      .object({
        name: z.string().min(1),
        values: z
          .array(
            z
              .object({
                value: z.unknown().optional(),
                end_time: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  ),
});

export type FacebookInsightsResponse = z.infer<typeof facebookInsightsResponseSchema>;
