import { platformSchema } from '@socialhub/shared';
import { z } from 'zod';

export const platformParamSchema = z.object({
  platform: platformSchema,
});

export type PlatformParam = z.infer<typeof platformParamSchema>;
