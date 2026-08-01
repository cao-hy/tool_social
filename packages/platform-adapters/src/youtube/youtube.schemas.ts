import { z } from 'zod';

const optionalNullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform<string | undefined>((value) => (value === null || value === '' ? undefined : value));

const optionalNullableNonNegativeInt = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform<number | undefined>((value) =>
    value === null || value === '' || value === undefined ? undefined : Number(value),
  )
  .pipe(z.number().int().nonnegative().optional());

export const youtubeTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type YouTubeTokenResponse = z.infer<typeof youtubeTokenResponseSchema>;

export const youtubeChannelSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: optionalNullableString,
      customUrl: optionalNullableString,
      thumbnails: z
        .record(
          z.object({
            url: optionalNullableString,
          }),
        )
        .optional(),
    })
    .optional(),
  statistics: z
    .object({
      subscriberCount: optionalNullableNonNegativeInt,
      hiddenSubscriberCount: z.boolean().optional(),
    })
    .optional(),
});

export type YouTubeChannel = z.infer<typeof youtubeChannelSchema>;

export const youtubeChannelsResponseSchema = z.object({
  items: z.array(youtubeChannelSchema),
});

export type YouTubeChannelsResponse = z.infer<typeof youtubeChannelsResponseSchema>;

export const youtubeVideoResponseSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: optionalNullableString,
      channelId: optionalNullableString,
      description: optionalNullableString,
      categoryId: optionalNullableString,
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  status: z
    .object({
      privacyStatus: optionalNullableString,
      uploadStatus: optionalNullableString,
      publishAt: optionalNullableString,
      failureReason: optionalNullableString,
      rejectionReason: optionalNullableString,
    })
    .optional(),
  processingDetails: z
    .object({
      processingStatus: optionalNullableString,
      processingFailureReason: optionalNullableString,
      fileDetailsAvailability: optionalNullableString,
      processingIssuesAvailability: optionalNullableString,
      tagSuggestionsAvailability: optionalNullableString,
      editorSuggestionsAvailability: optionalNullableString,
      thumbnailsAvailability: optionalNullableString,
      processingProgress: z
        .object({
          partsTotal: optionalNullableNonNegativeInt,
          partsProcessed: optionalNullableNonNegativeInt,
          timeLeftMs: optionalNullableNonNegativeInt,
        })
        .optional(),
    })
    .optional(),
  statistics: z
    .object({
      viewCount: optionalNullableNonNegativeInt,
      likeCount: optionalNullableNonNegativeInt,
      commentCount: optionalNullableNonNegativeInt,
    })
    .optional(),
});

export type YouTubeVideoResponse = z.infer<typeof youtubeVideoResponseSchema>;

export const youtubeVideosResponseSchema = z.object({
  items: z.array(youtubeVideoResponseSchema),
});

export type YouTubeVideosResponse = z.infer<typeof youtubeVideosResponseSchema>;

const youtubeAuthorChannelIdSchema = z
  .object({
    value: optionalNullableString,
  })
  .optional();

export const youtubeCommentSchema = z.object({
  id: z.string().min(1),
  snippet: z.object({
    authorDisplayName: optionalNullableString,
    authorProfileImageUrl: optionalNullableString,
    authorChannelId: youtubeAuthorChannelIdSchema,
    textDisplay: optionalNullableString,
    textOriginal: optionalNullableString,
    parentId: optionalNullableString,
    likeCount: optionalNullableNonNegativeInt,
    publishedAt: z.string().min(1),
    updatedAt: optionalNullableString,
  }),
});

export type YouTubeComment = z.infer<typeof youtubeCommentSchema>;

export const youtubeCommentThreadSchema = z.object({
  id: z.string().min(1),
  snippet: z.object({
    channelId: optionalNullableString,
    videoId: optionalNullableString,
    topLevelComment: youtubeCommentSchema,
    totalReplyCount: optionalNullableNonNegativeInt,
  }),
  replies: z
    .object({
      comments: z.array(youtubeCommentSchema).optional(),
    })
    .optional(),
});

export type YouTubeCommentThread = z.infer<typeof youtubeCommentThreadSchema>;

export const youtubeCommentThreadsResponseSchema = z.object({
  items: z.array(youtubeCommentThreadSchema),
  nextPageToken: optionalNullableString,
});

export type YouTubeCommentThreadsResponse = z.infer<typeof youtubeCommentThreadsResponseSchema>;
