import { z } from 'zod';
import { booleanFromString, logLevelSchema, nodeEnvSchema, port } from './load-env';

/* ------------------------------------------------------------ khối dùng chung */

const databaseSchema = z.object({
  DATABASE_URL: z.string().url().startsWith('postgres', {
    message: 'Phải là connection string PostgreSQL (postgres:// hoặc postgresql://)',
  }),
});

const redisSchema = z.object({
  REDIS_URL: z.string().url().startsWith('redis', {
    message: 'Phải là connection string Redis (redis:// hoặc rediss://)',
  }),
});

/**
 * Khóa mã hóa token (SECURITY.md §2).
 *
 * Định dạng nhiều khóa để rotate được mà không phải dừng hệ thống:
 *   ENCRYPTION_KEYS=v1:<base64 32 byte>,v2:<base64 32 byte>
 *   ENCRYPTION_ACTIVE_KEY=v2
 *
 * Việc validate độ dài khóa nằm ở @socialhub/security (nơi hiểu định dạng),
 * ở đây chỉ kiểm tra hình dạng cơ bản để bắt lỗi sớm.
 */
const encryptionSchema = z.object({
  ENCRYPTION_KEYS: z
    .string()
    .min(1)
    .refine((v) => v.split(',').every((entry) => /^[\w.-]+:[A-Za-z0-9+/=]+$/.test(entry.trim())), {
      message: 'Định dạng phải là "version:base64key" phân tách bằng dấu phẩy',
    }),
  ENCRYPTION_ACTIVE_KEY: z.string().min(1),
});

const storageSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString(true),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
});

const observabilitySchema = z.object({
  LOG_LEVEL: logLevelSchema,
  SENTRY_DSN: z.string().url().optional(),
});

const syncSchema = z.object({
  EXTERNAL_POST_SYNC_CUTOFF_DAYS: z.coerce.number().int().min(1).default(365),
  EXTERNAL_POST_SYNC_MANUAL_COOLDOWN_HOURS: z.coerce.number().int().min(0).default(2),
});

const proxySchema = z.object({
  PROXY_ENABLED: booleanFromString(false),
  PROXY_COUNTRY_LOCK: z.string().optional(),
  PROXY_FINGERPRINT_SECRET: z
    .string()
    .min(1)
    .superRefine((val, ctx) => {
      try {
        const decoded = Buffer.from(val, 'base64');
        if (decoded.length < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'PROXY_FINGERPRINT_SECRET phải có tối thiểu 32 byte sau khi decode base64',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PROXY_FINGERPRINT_SECRET phải là chuỗi base64 hợp lệ',
        });
      }
    }),
});

/**
 * OAuth credential của từng nền tảng — TẤT CẢ đều optional.
 *
 * Có chủ đích: hệ thống phải khởi động được khi chưa có credential của nền tảng
 * nào (đúng thực tế Phase 1–2, và đúng với prompt §21 "không tự tạo credential
 * giả"). Việc thiếu credential được phát hiện tại thời điểm KẾT NỐI tài khoản,
 * với thông báo rõ ràng cho người dùng, chứ không phải bằng cách chặn cả app.
 */
const platformOAuthSchema = z.object({
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  FACEBOOK_WEBHOOK_SECRET: z.string().optional(),
  FACEBOOK_API_VERSION: z.string().optional(),
  FACEBOOK_LOGIN_CONFIG_ID: z.string().optional(),

  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),

  PINTEREST_APP_ID: z.string().optional(),
  PINTEREST_APP_SECRET: z.string().optional(),
  PINTEREST_DEFAULT_BOARD_NAME: z.string().optional(),
  PINTEREST_API_ENVIRONMENT: z.enum(['production', 'sandbox']).optional(),

  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),

  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
});

function validatePlatformOAuth(
  env: z.infer<typeof platformOAuthSchema>,
  ctx: z.RefinementCtx,
): void {
  const facebookValues = [
    ['FACEBOOK_APP_ID', env.FACEBOOK_APP_ID],
    ['FACEBOOK_APP_SECRET', env.FACEBOOK_APP_SECRET],
    ['FACEBOOK_API_VERSION', env.FACEBOOK_API_VERSION],
  ] as const;
  const hasAnyFacebook = facebookValues.some(([, value]) => Boolean(value));
  const hasAllFacebook = facebookValues.every(([, value]) => Boolean(value));

  if (hasAnyFacebook && !hasAllFacebook) {
    for (const [name, value] of facebookValues) {
      if (value) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message:
          'Bật Facebook adapter thật cần cấu hình đủ FACEBOOK_APP_ID, FACEBOOK_APP_SECRET và FACEBOOK_API_VERSION.',
      });
    }
  }

  const pinterestValues = [
    ['PINTEREST_APP_ID', env.PINTEREST_APP_ID],
    ['PINTEREST_APP_SECRET', env.PINTEREST_APP_SECRET],
  ] as const;
  const hasAnyPinterest = pinterestValues.some(([, value]) => Boolean(value));
  const hasAllPinterest = pinterestValues.every(([, value]) => Boolean(value));

  if (hasAnyPinterest && !hasAllPinterest) {
    for (const [name, value] of pinterestValues) {
      if (value) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message:
          'Bật Pinterest adapter thật cần cấu hình đủ PINTEREST_APP_ID và PINTEREST_APP_SECRET.',
      });
    }
  }

  const youtubeValues = [
    ['YOUTUBE_CLIENT_ID', env.YOUTUBE_CLIENT_ID],
    ['YOUTUBE_CLIENT_SECRET', env.YOUTUBE_CLIENT_SECRET],
  ] as const;
  const hasAnyYouTube = youtubeValues.some(([, value]) => Boolean(value));
  const hasAllYouTube = youtubeValues.every(([, value]) => Boolean(value));

  if (hasAnyYouTube && !hasAllYouTube) {
    for (const [name, value] of youtubeValues) {
      if (value) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message:
          'Bật YouTube adapter thật cần cấu hình đủ YOUTUBE_CLIENT_ID và YOUTUBE_CLIENT_SECRET.',
      });
    }
  }

  const tiktokValues = [
    ['TIKTOK_CLIENT_KEY', env.TIKTOK_CLIENT_KEY],
    ['TIKTOK_CLIENT_SECRET', env.TIKTOK_CLIENT_SECRET],
  ] as const;
  const hasAnyTikTok = tiktokValues.some(([, value]) => Boolean(value));
  const hasAllTikTok = tiktokValues.every(([, value]) => Boolean(value));

  if (hasAnyTikTok && !hasAllTikTok) {
    for (const [name, value] of tiktokValues) {
      if (value) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message:
          'Bật TikTok adapter thật cần cấu hình đủ TIKTOK_CLIENT_KEY và TIKTOK_CLIENT_SECRET.',
      });
    }
  }
}

/* ------------------------------------------------------------------- apps */

export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    PORT: port(4000),
    API_BASE_URL: z.string().url(),
    WEB_BASE_URL: z.string().url(),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    SESSION_COOKIE_NAME: z.string().min(1).default('socialhub.sid'),
    SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
    TRUST_PROXY: booleanFromString(false),
  })
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(encryptionSchema)
  .merge(storageSchema)
  .merge(observabilitySchema)
  .merge(syncSchema)
  .merge(proxySchema)
  .merge(platformOAuthSchema)
  .superRefine((env, ctx) => {
    validatePlatformOAuth(env, ctx);
    if (env.NODE_ENV !== 'production') return;

    if (!env.API_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_BASE_URL'],
        message: 'Production bắt buộc dùng https',
      });
    }
    if (!env.WEB_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_BASE_URL'],
        message: 'Production bắt buộc dùng https',
      });
    }
    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message:
          'Production phải khai báo danh sách origin cụ thể — không được để trống (SECURITY.md §9)',
      });
    }
    if (env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'Không được dùng "*" cùng với cookie xác thực',
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    WORKER_CONCURRENCY_MULTIPLIER: z.coerce.number().min(0.1).max(10).default(1),
    /** Cổng cho health check của worker — worker không phục vụ traffic. */
    WORKER_HEALTH_PORT: port(4001),
    SCHEDULER_ENABLED: booleanFromString(true),
  })
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(encryptionSchema)
  .merge(storageSchema)
  .merge(observabilitySchema)
  .merge(syncSchema)
  .merge(proxySchema)
  .merge(platformOAuthSchema)
  .superRefine(validatePlatformOAuth);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Env của frontend.
 *
 * CỐ Ý không có DATABASE_URL, REDIS_URL, ENCRYPTION_KEYS hay bất kỳ secret nào
 * của nền tảng. Frontend không được biết những thứ đó tồn tại
 * (SECURITY.md §2.3 quy tắc 1 và §10).
 */
export const webEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('SocialHub Manager'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
