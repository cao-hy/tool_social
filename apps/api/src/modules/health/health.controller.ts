import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { raw } from '../../common/interceptors/response.interceptor';
import { HealthService } from './health.service';

/**
 * Endpoint hạ tầng, không nằm dưới /api/v1 và không bọc envelope.
 *
 * Lý do bỏ envelope: load balancer và orchestrator đọc những endpoint này bằng
 * các công cụ đơn giản, thường chỉ nhìn HTTP status. Bọc thêm một lớp
 * `{success, data, meta}` chỉ gây phiền mà không đem lại gì.
 */
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  getHealth(): unknown {
    return raw(this.health.getLiveness());
  }

  @Get('ready')
  async getReady(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    const result = await this.health.getReadiness();

    // 503 khi chưa sẵn sàng: load balancer ngừng gửi traffic, nhưng container
    // KHÔNG bị giết — nó sẽ tự phục hồi khi Postgres/Redis trở lại.
    void reply.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return raw(result);
  }
}
