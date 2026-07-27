import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { platformSchema, type Platform } from '@socialhub/shared';
import type { FastifyRequest } from 'fastify';
import { raw } from '../../common/interceptors/response.interceptor';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks/:platform')
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Get()
  verifyChallenge(
    @Param('platform', zodPipe(platformSchema)) platform: Platform,
    @Query() query: Record<string, string | undefined>,
  ) {
    return raw(this.webhooks.verifyChallenge(platform, query));
  }

  @Post()
  @HttpCode(200)
  receive(
    @Param('platform', zodPipe(platformSchema)) platform: Platform,
    @Req() request: FastifyRequest,
  ) {
    return this.webhooks.receive(platform, request);
  }
}
