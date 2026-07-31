import { z } from 'zod';

const optionalNullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform<string | undefined>((value) => (value === null || value === '' ? undefined : value));

const optionalNullableUrl = z
  .union([z.string(), z.null()])
  .optional()
  .transform<string | undefined>((value) => (value === null || value === '' ? undefined : value))
  .pipe(z.string().url().optional());

const optionalNullableNonNegativeInt = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform<number | undefined>((value) =>
    value === null || value === '' || value === undefined ? undefined : Number(value),
  )
  .pipe(z.number().int().nonnegative().optional());

export const pinterestTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  refresh_token_expires_at: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
});

export type PinterestTokenResponse = z.infer<typeof pinterestTokenResponseSchema>;

export const pinterestUserAccountSchema = z
  .object({
    id: optionalNullableString,
    username: optionalNullableString,
    business_name: optionalNullableString,
    account_type: optionalNullableString,
    profile_image: optionalNullableUrl,
    website_url: optionalNullableUrl,
    follower_count: optionalNullableNonNegativeInt,
  })
  .refine((value) => Boolean(value.id || value.username), {
    message: 'Pinterest user_account phải có id hoặc username.',
  });

export type PinterestUserAccount = z.infer<typeof pinterestUserAccountSchema>;

export const pinterestBoardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: optionalNullableString,
  privacy: optionalNullableString,
  owner: z
    .object({
      username: optionalNullableString,
    })
    .nullable()
    .optional(),
});

export type PinterestBoard = z.infer<typeof pinterestBoardSchema>;

export const pinterestBoardsResponseSchema = z.object({
  items: z.array(pinterestBoardSchema),
  bookmark: z.string().nullable().optional(),
});

export const pinterestCreatePinResponseSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional().nullable(),
  link: z.string().url().optional().nullable(),
  board_id: z.string().optional(),
  created_at: z.string().optional(),
});

export type PinterestCreatePinResponse = z.infer<typeof pinterestCreatePinResponseSchema>;

const pinterestImageVariantSchema = z.object({
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  url: z.string().url(),
});

const pinterestPinMetricsSchema = z
  .object({
    '90d': z.record(z.coerce.number()).optional(),
    lifetime_metrics: z.record(z.coerce.number()).optional(),
  })
  .passthrough();

export const pinterestPinSchema = z
  .object({
    id: z.string().min(1),
    title: optionalNullableString,
    description: optionalNullableString,
    link: optionalNullableUrl,
    board_id: optionalNullableString,
    board_section_id: optionalNullableString,
    created_at: optionalNullableString,
    creative_type: optionalNullableString,
    media: z
      .object({
        media_type: optionalNullableString,
        images: z.record(pinterestImageVariantSchema).optional(),
        video_url: optionalNullableUrl,
      })
      .passthrough()
      .optional(),
    pin_metrics: pinterestPinMetricsSchema.optional(),
  })
  .passthrough();

export type PinterestPin = z.infer<typeof pinterestPinSchema>;

export const pinterestPinsResponseSchema = z.object({
  items: z.array(pinterestPinSchema),
  bookmark: z.string().nullable().optional(),
});

export type PinterestPinsResponse = z.infer<typeof pinterestPinsResponseSchema>;

const pinterestDailyMetricSchema = z
  .object({
    data_status: optionalNullableString,
    date: optionalNullableString,
    metrics: z.record(z.coerce.number()).optional(),
  })
  .passthrough();

export const pinterestPinAnalyticsResponseSchema = z.record(
  z
    .object({
      daily_metrics: z.array(pinterestDailyMetricSchema).optional(),
      summary_metrics: z.record(z.coerce.number()).optional(),
      lifetime_metrics: z.record(z.coerce.number()).optional(),
    })
    .passthrough(),
);

export type PinterestPinAnalyticsResponse = z.infer<typeof pinterestPinAnalyticsResponseSchema>;

export const pinterestMediaUploadResponseSchema = z.object({
  media_id: z.string().min(1),
  upload_url: z.string().url(),
  upload_parameters: z.record(z.string()),
});

export type PinterestMediaUploadResponse = z.infer<typeof pinterestMediaUploadResponseSchema>;

export const pinterestMediaDetailsResponseSchema = z.object({
  media_id: z.string().min(1).optional(),
  status: z.string().min(1),
});

export type PinterestMediaDetailsResponse = z.infer<typeof pinterestMediaDetailsResponseSchema>;

export const pinterestBoardSectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export type PinterestBoardSection = z.infer<typeof pinterestBoardSectionSchema>;

export const pinterestBoardSectionsResponseSchema = z.object({
  items: z.array(pinterestBoardSectionSchema),
  bookmark: z.string().nullable().optional(),
});

export const pinterestSavePinResponseSchema = pinterestPinSchema;
