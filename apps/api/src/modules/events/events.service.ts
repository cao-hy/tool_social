import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { workspaceRealtimeChannel, type WorkspaceRealtimeEvent } from '@socialhub/shared';
import Redis from 'ioredis';
import { logger } from '../../common/logger';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { RedisService } from '../../infrastructure/redis/redis.service';

export type WorkspaceEventListener = (event: WorkspaceRealtimeEvent) => void;

const CHANNEL_PATTERN = 'socialhub:ws:*:events';

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly subscriber: Redis;
  private readonly listenersByWorkspace = new Map<string, Set<WorkspaceEventListener>>();
  private subscribed = false;

  constructor(
    @Inject(ENV) env: ApiEnv,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    this.subscriber = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 250, 5000),
    });

    this.subscriber.on('error', (error: Error) => {
      logger.warn(
        { err: { name: error.name, message: error.message } },
        'Lỗi kết nối Redis Subscriber (SSE)',
      );
    });

    this.subscriber.on('pmessage', (_pattern: string, _channel: string, rawPayload: string) => {
      try {
        const parsed = JSON.parse(rawPayload) as WorkspaceRealtimeEvent;
        if (!parsed?.workspaceId || !parsed?.type) return;
        const listeners = this.listenersByWorkspace.get(parsed.workspaceId);
        if (!listeners || listeners.size === 0) return;
        for (const fn of listeners) {
          try {
            fn(parsed);
          } catch (listenerError) {
            logger.debug({ err: listenerError }, 'SSE listener callback failed');
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSubscribed();
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    try {
      if (this.subscriber.status !== 'ready' && this.subscriber.status !== 'connecting') {
        await this.subscriber.connect();
      }
      await this.subscriber.psubscribe(CHANNEL_PATTERN);
      this.subscribed = true;
    } catch (error) {
      logger.warn({ err: error }, 'Chưa khởi tạo được Redis psubscribe cho SSE, sẽ thử lại sau');
    }
  }

  subscribe(workspaceId: string, listener: WorkspaceEventListener): () => void {
    void this.ensureSubscribed();
    let bucket = this.listenersByWorkspace.get(workspaceId);
    if (!bucket) {
      bucket = new Set();
      this.listenersByWorkspace.set(workspaceId, bucket);
    }
    bucket.add(listener);

    return () => {
      const current = this.listenersByWorkspace.get(workspaceId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listenersByWorkspace.delete(workspaceId);
      }
    };
  }

  publish(
    workspaceId: string,
    partial: Omit<WorkspaceRealtimeEvent, 'id' | 'workspaceId' | 'timestamp'>,
  ): void {
    const event: WorkspaceRealtimeEvent = {
      id: randomUUID(),
      workspaceId,
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this.redis
      .getClient()
      .publish(workspaceRealtimeChannel(workspaceId), JSON.stringify(event))
      .catch((error: unknown) => {
        logger.debug({ err: error, workspaceId, type: event.type }, 'Publish SSE event failed');
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.listenersByWorkspace.clear();
    await this.subscriber.quit().catch(() => this.subscriber.disconnect());
  }
}
