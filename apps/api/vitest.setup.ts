import { logger } from './src/common/logger';

/**
 * Tắt log trong test.
 *
 * Nhiều test cố tình kích hoạt đường lỗi (500, token bị thu hồi, rate limit).
 * Nếu để log bật, output CI sẽ đầy stack trace của những lỗi ĐƯỢC MONG ĐỢI, và
 * người đọc không phân biệt được đâu là sự cố thật.
 */
logger.level = 'silent';
