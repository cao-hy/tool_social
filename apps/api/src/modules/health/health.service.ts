import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

export interface DependencyCheck {
  name: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: DependencyCheck[];
}

/**
 * Health vs Readiness — ARCHITECTURE.md §10.
 *
 * Phân biệt này quan trọng khi vận hành:
 *   • /health  (liveness)  — "process còn sống không?" Luôn 200 nếu event loop
 *     còn chạy. Trả 503 ở đây sẽ khiến orchestrator GIẾT container, và nếu
 *     nguyên nhân là database tạm thời chậm thì việc restart chỉ làm mọi thứ tệ
 *     hơn.
 *   • /ready   (readiness) — "nhận traffic được chưa?" Kiểm tra Postgres và
 *     Redis. Trả 503 chỉ khiến load balancer tạm ngừng gửi traffic, container
 *     vẫn sống và tự phục hồi khi dependency trở lại.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  getLiveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  async getReadiness(): Promise<ReadinessResult> {
    const checks = await Promise.all([
      this.timed('postgres', () => this.prisma.ping()),
      this.timed('redis', () => this.redis.ping()),
    ]);

    return { ready: checks.every((c) => c.healthy), checks };
  }

  private async timed(name: string, probe: () => Promise<boolean>): Promise<DependencyCheck> {
    const startedAt = Date.now();
    try {
      const healthy = await probe();
      return { name, healthy, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        name,
        healthy: false,
        latencyMs: Date.now() - startedAt,
        // Thông điệp lỗi kết nối có thể chứa connection string kèm mật khẩu.
        // Endpoint này thường được để lộ ra ngoài, nên chỉ trả nhãn chung chung.
        error: error instanceof Error ? error.name : 'UnknownError',
      };
    }
  }
}
