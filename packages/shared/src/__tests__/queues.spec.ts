import { describe, expect, it } from 'vitest';
import { buildJobId, QUEUE_NAMES, QUEUE_SETTINGS } from '../queues';

describe('cấu hình queue', () => {
  it('mọi queue trong prompt §10 đều có cấu hình', () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUE_SETTINGS[name]).toBeDefined();
      expect(QUEUE_SETTINGS[name].concurrency).toBeGreaterThan(0);
      expect(QUEUE_SETTINGS[name].attempts).toBeGreaterThan(0);
    }
  });

  it('đủ 14 queue theo roadmap hiện tại (bao gồm reconcile-platform-post)', () => {
    expect(QUEUE_NAMES).toHaveLength(14);
  });

  it('publish-post có nhiều lần thử nhất — đây là job người dùng nhìn thấy', () => {
    expect(QUEUE_SETTINGS['publish-post'].attempts).toBeGreaterThanOrEqual(5);
  });
});

describe('buildJobId — transport dedupe key', () => {
  it('mutation jobs use operationId so generations cannot suppress each other', () => {
    const a = buildJobId('publish-post', {
      platformPostId: 'pp_1',
      workspaceId: 'ws_1',
      correlationId: 'req-a',
      operationId: 'op_1',
    });
    const b = buildJobId('publish-post', {
      platformPostId: 'pp_1',
      workspaceId: 'ws_1',
      correlationId: 'req-b',
      operationId: 'op_2',
    });
    expect(a).not.toBe(b);
    expect(a).toContain('outbound-op_1');
  });

  it('legacy mutation payloads without operationId get a non-authorizing legacy id', () => {
    expect(
      buildJobId('retry-failed-post', {
        platformPostId: 'pp_1',
        workspaceId: 'ws_1',
        requestedByUserId: 'user_1',
      }),
    ).toContain('legacy-missing-operation');
  });

  it('create/reply comment job IDs are operation-scoped', () => {
    const create = buildJobId('create-platform-comment', {
      commandId: 'cmd_1',
      platformPostId: 'pp_1',
      socialAccountId: 'sa_1',
      workspaceId: 'ws_1',
      message: 'hello',
      requestedByUserId: 'user_1',
      correlationId: 'req_1',
      operationId: 'op_comment_1',
    });
    const reply = buildJobId('reply-platform-comment', {
      commentId: 'comment_1',
      workspaceId: 'ws_1',
      message: 'hello',
      requestedByUserId: 'user_1',
      correlationId: 'req_2',
      operationId: 'op_reply_1',
    });
    expect(create).toContain('outbound-op_comment_1');
    expect(reply).toContain('outbound-op_reply_1');
  });

  it('reconciliation job IDs prefer operation identity over legacy attempt identity', () => {
    const id = buildJobId('reconcile-platform-post', {
      platformPostId: 'pp_1',
      workspaceId: 'ws_1',
      publishAttemptId: 'attempt_1',
      operationId: 'op_reconcile_1',
    });
    expect(id).toContain('outbound-op_reconcile_1');
  });

  it('webhook idempotent theo event id — chống replay', () => {
    expect(buildJobId('process-webhook', { webhookEventId: 'evt_1' })).toBe(
      buildJobId('process-webhook', { webhookEventId: 'evt_1' }),
    );
  });

  it('sync-posts phân biệt theo cursor để không kẹt ở trang đầu', () => {
    const first = buildJobId('sync-posts', { socialAccountId: 'sa_1', workspaceId: 'ws_1' });
    const next = buildJobId('sync-posts', {
      socialAccountId: 'sa_1',
      workspaceId: 'ws_1',
      cursor: 'abc',
    });
    expect(first).not.toBe(next);
  });

  it('jobId luôn có tiền tố là tên queue — dễ truy vết trong Redis', () => {
    expect(
      buildJobId('sync-post-metrics', { platformPostId: 'pp_1', workspaceId: 'ws_1' }),
    ).toMatch(/^sync-post-metrics-/);
  });

  it('jobId không chứa dấu hai chấm vì BullMQ từ chối custom id có ":"', () => {
    expect(
      buildJobId('sync-comments', {
        socialAccountId: 'sa_1',
        workspaceId: 'ws_1',
        since: '2026-07-29T11:34:00.000Z',
      }),
    ).not.toContain(':');
  });
});
