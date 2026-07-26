import { createServer, type Server } from 'node:http';
import { loadEnvOrExit, loadWorkerEnv, type WorkerEnv } from '@socialhub/config';
import Redis from 'ioredis';
import { logger } from './logger';
import { QueueRegistry } from './queue/queue-registry';

/**
 * Worker chạy như một process riêng, KHÔNG phải một phần của HTTP API.
 *
 * Lý do (ARCHITECTURE.md §3): một job upload video có thể mất vài phút. Nếu
 * chạy chung process với API, nó sẽ chiếm event loop và làm tăng latency của
 * mọi request; và mỗi lần deploy sẽ giết job đang chạy giữa chừng.
 */

let shuttingDown = false;

async function main(): Promise<void> {
  const env: WorkerEnv = loadEnvOrExit(loadWorkerEnv);
  logger.level = env.LOG_LEVEL;

  const connection = new Redis(env.REDIS_URL, {
    // BullMQ yêu cầu null: nó tự quản lý retry, và giới hạn của ioredis sẽ
    // xung đột với cơ chế đó.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const registry = new QueueRegistry(connection, env.WORKER_CONCURRENCY_MULTIPLIER);
  registry.createQueues();

  // Phase 1 CỐ Ý chưa đăng ký processor nghiệp vụ nào. Mục tiêu của phase này
  // là chứng minh hạ tầng queue chạy được: kết nối Redis, cấu hình retry, tắt
  // êm. Processor thật đến ở Phase 5 (docs/ROADMAP.md).
  logger.warn(
    { queues: registry.getQueueNames().length },
    'Worker chạy ở chế độ hạ tầng — chưa có processor nghiệp vụ (Phase 1)',
  );

  const healthServer = startHealthServer(env, registry, connection);

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Nhận tín hiệu dừng');
    healthServer.close();
    await registry.shutdown(30_000);
    await connection.quit().catch(() => connection.disconnect());
    logger.info('Worker đã dừng');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ err: reason }, 'Promise bị reject mà không được xử lý');
  });

  logger.info({ port: env.WORKER_HEALTH_PORT }, 'Worker sẵn sàng');
}

/**
 * HTTP server tối giản chỉ để phục vụ health check.
 *
 * Worker không phục vụ traffic, nhưng orchestrator vẫn cần biết nó còn sống —
 * nếu không, một worker treo sẽ nằm im mãi mà không ai phát hiện.
 */
function startHealthServer(env: WorkerEnv, registry: QueueRegistry, connection: Redis): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: shuttingDown ? 'shutting_down' : 'ok',
          uptimeSeconds: Math.floor(process.uptime()),
          queues: registry.getQueueNames().length,
          workers: registry.getWorkerCount(),
        }),
      );
      return;
    }

    if (req.url === '/ready') {
      const ready = !shuttingDown && connection.status === 'ready';
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, redis: connection.status }));
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(env.WORKER_HEALTH_PORT);
  return server;
}

void main().catch((error: unknown) => {
  console.error('Khởi động worker thất bại:', error);
  process.exit(1);
});
