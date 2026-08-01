import { z } from 'zod';

export const listJobActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  includeCompleted: z.coerce.boolean().default(true),
});

export type ListJobActivityQuery = z.infer<typeof listJobActivityQuerySchema>;
