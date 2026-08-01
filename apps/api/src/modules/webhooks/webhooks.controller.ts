import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Platform } from '@socialhub/shared';
import type { FastifyRequest } from 'fastify';
import { raw } from '../../common/interceptors/response.interceptor';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks/:platform')
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Get()
  verifyChallenge(
    @Param('platform') platformStr: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    return raw(this.webhooks.verifyChallenge(platformStr.toUpperCase() as Platform, query));
  }

  @Post()
  @HttpCode(200)
  receive(@Param('platform') platformStr: string, @Req() request: FastifyRequest) {
    return this.webhooks.receive(platformStr.toUpperCase() as Platform, request);
  }
}
