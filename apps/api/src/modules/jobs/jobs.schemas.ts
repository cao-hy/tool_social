import { z } from 'zod';

export const listJobActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  includeCompleted: z.coerce.boolean().default(true),
});

export type ListJobActivityQuery = z.infer<typeof listJobActivityQuerySchema>;

export const jobStatusQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1)).min(1).max(100)),
});

export type JobStatusQuery = z.infer<typeof jobStatusQuerySchema>;
