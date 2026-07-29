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

export const tiktokErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  log_id: z.string().optional(),
});

export const tiktokTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().optional(),
  open_id: z.string().min(1),
  refresh_expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type TikTokTokenResponse = z.infer<typeof tiktokTokenResponseSchema>;

export const tiktokUserInfoResponseSchema = z.object({
  data: z.object({
    user: z.object({
      open_id: z.string().min(1),
      union_id: optionalNullableString,
      avatar_url: optionalNullableString,
      avatar_url_100: optionalNullableString,
      avatar_large_url: optionalNullableString,
      display_name: optionalNullableString,
      profile_deep_link: optionalNullableString,
      username: optionalNullableString,
      follower_count: optionalNullableNonNegativeInt,
    }),
  }),
  error: tiktokErrorSchema.optional(),
});

export type TikTokUserInfoResponse = z.infer<typeof tiktokUserInfoResponseSchema>;

export const tiktokCreatorInfoResponseSchema = z.object({
  data: z.object({
    creator_avatar_url: optionalNullableString,
    creator_username: optionalNullableString,
    creator_nickname: optionalNullableString,
    privacy_level_options: z.array(z.string()).default([]),
    comment_disabled: z.boolean().optional(),
    duet_disabled: z.boolean().optional(),
    stitch_disabled: z.boolean().optional(),
    max_video_post_duration_sec: optionalNullableNonNegativeInt,
  }),
  error: tiktokErrorSchema.optional(),
});

export type TikTokCreatorInfoResponse = z.infer<typeof tiktokCreatorInfoResponseSchema>;

export const tiktokPublishInitResponseSchema = z.object({
  data: z.object({
    publish_id: z.string().min(1),
    upload_url: z.string().url().optional(),
  }),
  error: tiktokErrorSchema.optional(),
});

export type TikTokPublishInitResponse = z.infer<typeof tiktokPublishInitResponseSchema>;

export const tiktokPublishStatusResponseSchema = z.object({
  data: z.object({
    status: z.string().min(1),
    fail_reason: optionalNullableString,
    publicaly_available_post_id: z.array(z.union([z.string(), z.number()])).optional(),
    uploaded_bytes: optionalNullableNonNegativeInt,
    downloaded_bytes: optionalNullableNonNegativeInt,
  }),
  error: tiktokErrorSchema.optional(),
});

export type TikTokPublishStatusResponse = z.infer<typeof tiktokPublishStatusResponseSchema>;
