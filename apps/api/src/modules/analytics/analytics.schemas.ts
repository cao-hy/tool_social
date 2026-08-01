import { platformSchema } from '@socialhub/shared';
import { z } from 'zod';

export const analyticsQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  platform: platformSchema.optional(),
  socialAccountId: z.string().min(1).optional(),
});

export const syncAnalyticsSchema = z
  .object({
    platformPostIds: z.array(z.string().min(1)).max(50).optional(),
    platform: platformSchema.optional(),
    socialAccountId: z.string().min(1).optional(),
  })
  .strict();

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type SyncAnalyticsInput = z.infer<typeof syncAnalyticsSchema>;
