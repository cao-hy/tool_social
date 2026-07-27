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

export const instagramPublishResponseSchema = z.object({
  id: z.string(),
});
