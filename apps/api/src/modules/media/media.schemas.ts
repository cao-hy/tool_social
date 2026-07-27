import { z } from 'zod';

export const createMediaUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  declaredMimeType: z.string().trim().min(1).max(120),
});

export type CreateMediaUploadInput = z.infer<typeof createMediaUploadSchema>;
