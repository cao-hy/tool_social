import { type Prisma, PrismaClient } from '../generated/client';

export type PrismaClientInstance = PrismaClient;

export interface PrismaClientOptions {
  databaseUrl: string;
  /** Bật log query — chỉ dùng khi debug, output rất nhiều. */
  logQueries?: boolean;
}

/**
 * Tùy chọn khởi tạo PrismaClient dùng chung cho `api` và `worker`.
 *
 * Trả về options thay vì trả về client đã tạo, để NestJS `PrismaService` có thể
 * `extends PrismaClient` (mô hình chuẩn của Nest, cho phép inject và hook vòng
 * đời) mà vẫn dùng chung một nơi cấu hình duy nhất.
 */
export function buildPrismaOptions(options: PrismaClientOptions): Prisma.PrismaClientOptions {
  return {
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? [
          { emit: 'stdout', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  };
}

export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  return new PrismaClient(buildPrismaOptions(options));
}
