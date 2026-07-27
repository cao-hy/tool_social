import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalizedWebhookEvent } from '../core/types';

export function verifyMetaWebhookSignature(input: {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  appSecret: string;
}): boolean {
  const header = input.headers['x-hub-signature-256'];
  if (!header?.startsWith('sha256=') || !input.appSecret) return false;

  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = Buffer.from(
    createHmac('sha256', input.appSecret).update(input.rawBody).digest('hex'),
    'hex',
  );
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function parseMetaWebhookEvents(payload: unknown): NormalizedWebhookEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];

  const events: NormalizedWebhookEvent[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry)) continue;
    const externalAccountId = stringValue(entry.id);
    const occurredAt = dateFromSeconds(numberValue(entry.time));
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (!isRecord(change)) continue;
      const value = isRecord(change.value) ? change.value : {};
      const eventType = stringValue(change.field) ?? 'unknown';
      const externalCommentId =
        stringValue(value.comment_id) ?? stringValue(value.commentId) ?? stringValue(value.id);
      const externalPostId =
        stringValue(value.post_id) ??
        stringValue(value.postId) ??
        stringValue(value.media_id) ??
        stringValue(value.mediaId) ??
        stringValue(value.parent_id);

      events.push({
        externalEventId: [
          externalAccountId ?? 'account',
          numberValue(entry.time)?.toString() ?? 'time',
          eventType,
          externalCommentId ?? externalPostId ?? hashJson(value),
        ].join(':'),
        eventType,
        externalAccountId,
        externalPostId,
        externalCommentId,
        occurredAt,
        raw: change,
      });
    }
  }

  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dateFromSeconds(value: number | undefined): Date {
  return value ? new Date(value * 1000) : new Date();
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
