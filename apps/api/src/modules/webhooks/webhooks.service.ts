import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma } from '@socialhub/db';
import { buildJobId, platformSchema, type Platform } from '@socialhub/shared';
import type { AdapterRegistry } from '@socialhub/platform-adapters';
import { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors/app-error';
import { ADAPTER_REGISTRY } from '../../infrastructure/infrastructure.module';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

type WebhookRequest = FastifyRequest & { rawBody?: Buffer };

@Injectable()
export class WebhooksService implements OnModuleDestroy {
  private readonly processQueue: Queue;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ADAPTER_REGISTRY) private readonly adapters: AdapterRegistry,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {
    this.processQueue = new Queue('process-webhook', { connection: this.redis.getClient() });
  }

  async onModuleDestroy(): Promise<void> {
    await this.processQueue.close();
  }

  verifyChallenge(platform: Platform, query: Record<string, string | undefined>) {
    platformSchema.parse(platform);
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || !challenge)
      throw AppError.validation('Webhook challenge không hợp lệ.');
    if (this.verifyTokenFor(platform) !== token) {
      throw AppError.unauthenticated('Webhook verify token không hợp lệ.');
    }

    return challenge;
  }

  async receive(platform: Platform, request: WebhookRequest) {
    platformSchema.parse(platform);
    const rawBody = request.rawBody;
    if (!rawBody) throw AppError.validation('Webhook cần raw body để xác thực chữ ký.');

    const adapter = this.adapters.get(platform);
    const headers = normalizeHeaders(request.headers);
    if (!adapter.verifyWebhookSignature?.(rawBody, headers)) {
      throw AppError.unauthenticated('Webhook signature không hợp lệ.');
    }

    const parsedEvents = adapter.parseWebhookEvents?.(request.body) ?? [];
    const externalEventId = eventIdentity(
      rawBody,
      parsedEvents.map((event) => event.externalEventId),
    );
    const eventType = parsedEvents[0]?.eventType;

    try {
      const webhookEvent = await this.prisma.webhookEvent.create({
        data: {
          platform,
          externalEventId,
          eventType,
          payload: request.body as Prisma.InputJsonValue,
          headers: safeHeaders(headers) as Prisma.InputJsonValue,
          signatureOk: true,
        },
      });
      const jobId = buildJobId('process-webhook', { webhookEventId: webhookEvent.id });
      await this.processQueue.add(
        'process-webhook',
        { webhookEventId: webhookEvent.id },
        { jobId },
      );
      return { accepted: true, duplicate: false, webhookEventId: webhookEvent.id, jobId };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { accepted: true, duplicate: true };
      }
      throw error;
    }
  }

  private verifyTokenFor(platform: Platform): string | undefined {
    if (platform === 'FACEBOOK' || platform === 'INSTAGRAM')
      return this.env.FACEBOOK_WEBHOOK_SECRET;
    return undefined;
  }
}

function normalizeHeaders(headers: FastifyRequest['headers']): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value[0] : value?.toString(),
    ]),
  );
}

function safeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    'content-type': headers['content-type'],
    'x-hub-signature-256': headers['x-hub-signature-256'] ? '[redacted]' : undefined,
    'x-request-id': headers['x-request-id'],
  };
}

function eventIdentity(rawBody: Buffer, eventIds: string[]): string {
  const basis = eventIds.length > 0 ? eventIds.join('|') : rawBody;
  return createHash('sha256').update(basis).digest('hex');
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
