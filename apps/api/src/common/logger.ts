import { PINO_REDACT_PATHS, REDACTION_PLACEHOLDER } from '@socialhub/security';
import pino, { type Logger } from 'pino';

/**
 * Logger structured dùng chung cho `api`.
 *
 * `redact` KHÔNG phải tùy chọn. Nếu access token lọt vào log, nó sẽ nằm ở đó
 * vĩnh viễn, được sao chép sang mọi hệ thống thu thập log, và không có cách nào
 * rút lại (SECURITY.md §2.3 quy tắc 2). Cấu hình redact được tập trung ở
 * @socialhub/security để `api` và `worker` không thể cấu hình lệch nhau.
 */
export function createLogger(options: { level: string; name: string }): Logger {
  return pino({
    name: options.name,
    level: options.level,
    redact: {
      paths: [...PINO_REDACT_PATHS],
      censor: REDACTION_PLACEHOLDER,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Instance mặc định.
 *
 * Level được đặt lại trong bootstrap sau khi env đã validate. Trước thời điểm
 * đó vẫn cần log được (chính là để báo lỗi cấu hình), nên instance này tồn tại
 * sẵn với level an toàn.
 */
export const logger: Logger = createLogger({ level: 'info', name: 'api' });
