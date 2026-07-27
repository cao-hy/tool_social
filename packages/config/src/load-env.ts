import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import * as dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Lỗi cấu hình môi trường.
 *
 * Cố ý là một class riêng để bootstrap của từng app bắt được nó và in ra thông
 * báo dành cho con người, thay vì để lộ stack trace của Zod.
 */
export class EnvValidationError extends Error {
  constructor(
    readonly appName: string,
    readonly issues: readonly z.ZodIssue[],
  ) {
    super(EnvValidationError.format(appName, issues));
    this.name = 'EnvValidationError';
  }

  private static format(appName: string, issues: readonly z.ZodIssue[]): string {
    const lines = issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  • ${key}: ${issue.message}`;
    });
    return [
      '',
      `Cấu hình môi trường không hợp lệ cho "${appName}":`,
      ...lines,
      '',
      'Xem .env.example để biết danh sách biến bắt buộc.',
      '',
    ].join('\n');
  }
}

/**
 * Validate biến môi trường theo schema và trả về object đã có kiểu.
 *
 * Chạy MỘT LẦN lúc khởi động (ARCHITECTURE.md §11). Thiếu biến thì process
 * phải chết ngay tại đây, chứ không phải chết vào 3 giờ sáng khi một job cụ thể
 * lần đầu chạm tới biến đó.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  appName: string,
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(appName, result.error.issues);
  }
  return result.data;
}

/** Tìm file .env gần nhất khi process chạy từ workspace con như apps/api. */
export function findNearestDotEnv(startDir: string = process.cwd()): string | undefined {
  let current = startDir;
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, '.env');
    if (existsSync(candidate)) return candidate;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

/** Nạp file .env vào process.env (chỉ dùng cho local dev). */
export function loadDotEnv(path?: string): void {
  const resolvedPath = path ?? findNearestDotEnv();
  dotenv.config(resolvedPath === undefined ? {} : { path: resolvedPath });
}

/* ---------------------------------------------------------------- helpers */

/** Biến môi trường luôn là chuỗi — helper này chuyển an toàn sang boolean. */
export const booleanFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

export const port = (defaultValue: number) =>
  z.coerce.number().int().min(1).max(65535).default(defaultValue);

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const nodeEnvSchema = z.enum(NODE_ENVS).default('development');

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
  .default('info');

/** URL bắt buộc dùng https ở production — chặn cấu hình sai gây rò rỉ cookie. */
export const httpsUrlInProduction = (isProduction: boolean) =>
  z
    .string()
    .url()
    .refine((v) => !isProduction || v.startsWith('https://'), {
      message: 'Phải dùng https:// ở môi trường production',
    });
