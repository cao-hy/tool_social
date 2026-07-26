import { logger } from './src/logger';

// Nhiều test cố tình kích hoạt đường lỗi; log bật sẽ làm ngập output CI bằng
// những thất bại ĐƯỢC MONG ĐỢI.
logger.level = 'silent';
