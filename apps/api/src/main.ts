import 'reflect-metadata';

import { loadApiEnv, loadEnvOrExit } from '@socialhub/config';
import { createApp } from './bootstrap';
import { createLogger } from './common/logger';

async function main(): Promise<void> {
  // Validate env TRƯỚC khi dựng bất cứ thứ gì. Thiếu biến thì chết ngay tại
  // đây với thông báo rõ ràng, thay vì chết lúc 3 giờ sáng khi một job cụ thể
  // lần đầu chạm tới biến đó (ARCHITECTURE.md §11).
  const env = loadEnvOrExit(loadApiEnv);
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'api' });

  const app = await createApp(env);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      corsOrigins: env.CORS_ORIGINS,
    },
    `API sẵn sàng tại ${env.API_BASE_URL}`,
  );

  // eslint-disable-next-line no-restricted-properties
  if (env.NODE_ENV !== 'production' && process.env.LOG_DIRECT_OUTBOUND_IP === 'true') {
    fetch('https://api.ipify.org?format=json')
      .then((r) => r.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((data: any) => logger.info(`🌐 Direct outbound IP của API: ${data.ip}`))
      .catch((err) => logger.warn(`Không lấy được Outbound IP: ${err.message}`));
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'Nhận tín hiệu dừng, đang đóng ứng dụng…');
      void app.close().then(() => process.exit(0));
    });
  }
}

void main().catch((error: unknown) => {
  // Dùng console vì logger có thể chưa khởi tạo được ở giai đoạn này.
  console.error('Khởi động API thất bại:', error);
  process.exit(1);
});

// trigger restart
