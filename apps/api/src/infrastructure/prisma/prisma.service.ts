import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { buildPrismaOptions, PrismaClient } from '@socialhub/db';
import { ENV, type ApiEnv } from '../env.provider';
import { logger } from '../../common/logger';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: ApiEnv) {
    super(
      buildPrismaOptions({
        databaseUrl: env.DATABASE_URL,
        logQueries: env.LOG_LEVEL === 'trace',
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    logger.info('Đã kết nối PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Dùng cho readiness probe. Câu truy vấn rẻ nhất có thể. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Kiểm tra kết nối PostgreSQL thất bại');
      return false;
    }
  }
}
