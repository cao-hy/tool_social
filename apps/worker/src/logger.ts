import { PINO_REDACT_PATHS, REDACTION_PLACEHOLDER } from '@socialhub/security';
import pino, { type Logger } from 'pino';

/**
 * Logger của worker.
 *
 * Dùng chung cấu hình redact với `api` (từ @socialhub/security) để hai process
 * không thể lệch nhau về việc trường nào bị che — một chỗ quên redact là đủ để
 * token nằm vĩnh viễn trong hệ thống thu thập log.
 */
export function createWorkerLogger(level: string): Logger {
  return pino({
    name: 'worker',
    level,
    redact: { paths: [...PINO_REDACT_PATHS], censor: REDACTION_PLACEHOLDER },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger: Logger = createWorkerLogger('info');
