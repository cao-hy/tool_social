export * from './load-env';
export * from './proxy';
export * from './proxy-dispatcher-pool';
export * from './schemas';

import { EnvValidationError, loadDotEnv, parseEnv } from './load-env';
import {
  apiEnvSchema,
  webEnvSchema,
  workerEnvSchema,
  type ApiEnv,
  type WebEnv,
  type WorkerEnv,
} from './schemas';

export function loadApiEnv(source?: NodeJS.ProcessEnv): ApiEnv {
  return parseEnv('api', apiEnvSchema, source);
}

export function loadWorkerEnv(source?: NodeJS.ProcessEnv): WorkerEnv {
  return parseEnv('worker', workerEnvSchema, source);
}

export function loadWebEnv(source?: NodeJS.ProcessEnv): WebEnv {
  return parseEnv('web', webEnvSchema, source);
}

/**
 * Dùng ở đầu file bootstrap của mỗi app.
 *
 * In thông báo dành cho con người rồi thoát với mã 1 — thay vì ném stack trace
 * của Zod ra màn hình, thứ mà không ai đọc được lúc 3 giờ sáng.
 */
export function loadEnvOrExit<T>(load: () => T, options: { dotenv?: boolean } = {}): T {
  if (options.dotenv !== false) loadDotEnv();
  try {
    return load();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
