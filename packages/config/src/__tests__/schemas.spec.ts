import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, findNearestDotEnv, parseEnv } from '../load-env';
import { apiEnvSchema, webEnvSchema, workerEnvSchema } from '../schemas';

const validApiEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  API_BASE_URL: 'http://localhost:4000',
  WEB_BASE_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/socialhub',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEYS: 'v1:c29tZS0zMi1ieXRlLWtleS1mb3ItdGVzdGluZy1vbmx5',
  ENCRYPTION_ACTIVE_KEY: 'v1',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'socialhub-media',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
} satisfies NodeJS.ProcessEnv;

describe('findNearestDotEnv — workspace con vẫn dùng .env ở root repo', () => {
  it('đi ngược lên thư mục cha để tìm .env gần nhất', () => {
    const root = mkdtempSync(join(tmpdir(), 'socialhub-env-'));
    const appDir = join(root, 'apps', 'api');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(root, '.env'), 'NODE_ENV=development\n');

    try {
      expect(findNearestDotEnv(appDir)).toBe(join(root, '.env'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('apiEnvSchema — fail fast lúc khởi động (ARCHITECTURE.md §11)', () => {
  it('chấp nhận cấu hình hợp lệ và áp default', () => {
    const env = parseEnv('api', apiEnvSchema, validApiEnv);
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SESSION_COOKIE_NAME).toBe('socialhub.sid');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('thiếu DATABASE_URL → ném lỗi CHỈ RÕ biến nào thiếu', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validApiEnv;
    expect(() => parseEnv('api', apiEnvSchema, withoutDb)).toThrow(EnvValidationError);

    try {
      parseEnv('api', apiEnvSchema, withoutDb);
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).toContain('api');
    }
  });

  it('gom TẤT CẢ lỗi trong một lần, không dừng ở lỗi đầu tiên', () => {
    try {
      parseEnv('api', apiEnvSchema, { NODE_ENV: 'development' });
      expect.unreachable('phải ném lỗi');
    } catch (error) {
      const err = error as EnvValidationError;
      expect(err.issues.length).toBeGreaterThan(3);
      expect(err.message).toContain('DATABASE_URL');
      expect(err.message).toContain('REDIS_URL');
    }
  });

  it('DATABASE_URL không phải postgres → từ chối', () => {
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'mysql://localhost:3306/db' }),
    ).toThrow(EnvValidationError);
  });

  it('ENCRYPTION_KEYS sai định dạng → từ chối', () => {
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...validApiEnv, ENCRYPTION_KEYS: 'khong-co-version' }),
    ).toThrow(EnvValidationError);
  });

  it('nhiều khóa mã hóa (rotate) được chấp nhận', () => {
    const env = parseEnv('api', apiEnvSchema, {
      ...validApiEnv,
      ENCRYPTION_KEYS: 'v1:YWJj,v2:ZGVm',
      ENCRYPTION_ACTIVE_KEY: 'v2',
    });
    expect(env.ENCRYPTION_ACTIVE_KEY).toBe('v2');
  });

  it('PORT không phải số → từ chối', () => {
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, PORT: 'abc' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('apiEnvSchema — ràng buộc riêng của production', () => {
  const prodBase = {
    ...validApiEnv,
    NODE_ENV: 'production',
    API_BASE_URL: 'https://api.example.com',
    WEB_BASE_URL: 'https://app.example.com',
    CORS_ORIGINS: 'https://app.example.com',
  };

  it('cấu hình production hợp lệ được chấp nhận', () => {
    expect(() => parseEnv('api', apiEnvSchema, prodBase)).not.toThrow();
  });

  it('production dùng http → từ chối', () => {
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...prodBase, API_BASE_URL: 'http://api.example.com' }),
    ).toThrow(EnvValidationError);
  });

  it('production để trống CORS_ORIGINS → từ chối', () => {
    expect(() => parseEnv('api', apiEnvSchema, { ...prodBase, CORS_ORIGINS: '' })).toThrow(
      EnvValidationError,
    );
  });

  it('production dùng CORS "*" → từ chối (đi kèm cookie là lỗ hổng)', () => {
    expect(() => parseEnv('api', apiEnvSchema, { ...prodBase, CORS_ORIGINS: '*' })).toThrow(
      EnvValidationError,
    );
  });

  it('development KHÔNG bị ép các luật trên — dev vẫn dùng http được', () => {
    expect(() => parseEnv('api', apiEnvSchema, validApiEnv)).not.toThrow();
  });
});

describe('apiEnvSchema — credential nền tảng là optional', () => {
  it('khởi động được khi chưa có credential nền tảng nào (prompt §21)', () => {
    const env = parseEnv('api', apiEnvSchema, validApiEnv);
    expect(env.FACEBOOK_APP_ID).toBeUndefined();
    expect(env.TIKTOK_CLIENT_KEY).toBeUndefined();
  });

  it('bật TikTok adapter thật thì phải có đủ Client Key và Client Secret', () => {
    expect(() =>
      parseEnv('api', apiEnvSchema, {
        ...validApiEnv,
        TIKTOK_CLIENT_KEY: 'client-key',
      }),
    ).toThrow(EnvValidationError);

    const env = parseEnv('api', apiEnvSchema, {
      ...validApiEnv,
      TIKTOK_CLIENT_KEY: 'client-key',
      TIKTOK_CLIENT_SECRET: 'client-secret',
    });
    expect(env.TIKTOK_CLIENT_KEY).toBe('client-key');
  });
});

describe('workerEnvSchema', () => {
  it('worker cần DB, Redis và khóa mã hóa nhưng KHÔNG cần PORT của API', () => {
    const env = parseEnv('worker', workerEnvSchema, validApiEnv);
    expect(env.DATABASE_URL).toBeDefined();
    expect(env.SCHEDULER_ENABLED).toBe(true);
    expect(env).not.toHaveProperty('API_BASE_URL');
  });

  it('SCHEDULER_ENABLED=false được parse thành boolean', () => {
    const env = parseEnv('worker', workerEnvSchema, {
      ...validApiEnv,
      SCHEDULER_ENABLED: 'false',
    });
    expect(env.SCHEDULER_ENABLED).toBe(false);
  });
});

describe('webEnvSchema — frontend không được thấy secret (SECURITY.md §10)', () => {
  it('chỉ nhận biến công khai', () => {
    const env = parseEnv('web', webEnvSchema, {
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
    });
    expect(env.NEXT_PUBLIC_APP_NAME).toBe('SocialHub Manager');
  });

  it('secret truyền vào cũng bị loại khỏi kết quả — không lọt vào bundle', () => {
    const env = parseEnv('web', webEnvSchema, {
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ENCRYPTION_KEYS: 'v1:secret',
      FACEBOOK_APP_SECRET: 'super-secret',
    });
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('ENCRYPTION_KEYS');
    expect(env).not.toHaveProperty('FACEBOOK_APP_SECRET');
    expect(JSON.stringify(env)).not.toContain('super-secret');
  });

  it('thiếu NEXT_PUBLIC_API_BASE_URL → từ chối', () => {
    expect(() => parseEnv('web', webEnvSchema, { NODE_ENV: 'production' })).toThrow(
      EnvValidationError,
    );
  });
});
