import { z } from 'zod';

export const listMediaSchema = z.object({
  q: z.string().trim().max(120).optional(),
  type: z.enum(['IMAGE', 'VIDEO']).optional(),
  status: z
    .enum(['PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'ARCHIVED'])
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createMediaUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  declaredMimeType: z.string().trim().min(1).max(120),
});

export const completeMultipartUploadSchema = z.object({
  uploadId: z.string().trim().min(1).max(1024),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().trim().min(1).max(256),
      }),
    )
    .min(1)
    .max(10_000),
});

export const abortMultipartUploadSchema = z.object({
  uploadId: z.string().trim().min(1).max(1024),
});

export const renameMediaSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1, 'Tên media không được để trống.')
    .max(255, 'Tên media tối đa 255 ký tự.'),
});

export type ListMediaInput = z.infer<typeof listMediaSchema>;
export type CreateMediaUploadInput = z.infer<typeof createMediaUploadSchema>;
export type CompleteMultipartUploadInput = z.infer<typeof completeMultipartUploadSchema>;
export type AbortMultipartUploadInput = z.infer<typeof abortMultipartUploadSchema>;
export type RenameMediaInput = z.infer<typeof renameMediaSchema>;
