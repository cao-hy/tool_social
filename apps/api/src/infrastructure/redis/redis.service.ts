import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type ApiEnv } from '../env.provider';
import { logger } from '../../common/logger';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(ENV) env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, {
      // BullMQ yêu cầu null; đặt luôn ở đây để `api` và `worker` dùng chung
      // một chính sách kết nối.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });

    this.client.on('error', (error: Error) => {
      // Không để lỗi kết nối Redis làm sập process — readiness probe sẽ báo
      // not-ready và orchestrator quyết định phải làm gì.
      logger.error({ err: { name: error.name, message: error.message } }, 'Lỗi kết nối Redis');
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.client.status === 'ready' || this.client.status === 'connecting') return;
    await this.client.connect();
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error({ err: error }, 'Kiểm tra kết nối Redis thất bại');
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
