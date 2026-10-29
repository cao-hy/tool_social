import { Controller, Get, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { EventsService } from './events.service';

const HEARTBEAT_INTERVAL_MS = 25_000;

@Controller('workspaces/:workspaceId/events')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class EventsController {
  constructor(
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get('stream')
  @RequirePermissions('notification:view')
  stream(
    @Param('workspaceId') workspaceId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): void {
    reply.hijack();

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };

    const requestOrigin = req.headers.origin;
    if (requestOrigin && this.env.CORS_ORIGINS.includes(requestOrigin)) {
      headers['Access-Control-Allow-Origin'] = requestOrigin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers.Vary = 'Origin';
    }

    reply.raw.writeHead(200, headers);
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ ok: true, workspaceId })}\n\n`);

    const unsubscribe = this.events.subscribe(workspaceId, (event) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  }
}
