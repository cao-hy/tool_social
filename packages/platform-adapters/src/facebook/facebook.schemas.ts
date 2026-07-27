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
