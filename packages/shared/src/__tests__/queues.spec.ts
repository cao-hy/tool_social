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

  it('đủ 13 queue theo roadmap hiện tại', () => {
    expect(QUEUE_NAMES).toHaveLength(13);
  });

  it('publish-post có nhiều lần thử nhất — đây là job người dùng nhìn thấy', () => {
    expect(QUEUE_SETTINGS['publish-post'].attempts).toBeGreaterThanOrEqual(5);
  });
});

describe('buildJobId — khóa idempotency (chống rủi ro R9: double post)', () => {
  it('cùng platformPostId → cùng jobId, dù correlationId khác nhau', () => {
    const a = buildJobId('publish-post', {
      platformPostId: 'pp_1',
      workspaceId: 'ws_1',
      correlationId: 'req-a',
    });
    const b = buildJobId('publish-post', {
      platformPostId: 'pp_1',
      workspaceId: 'ws_1',
      correlationId: 'req-b',
    });
    expect(a).toBe(b);
  });

  it('platformPostId khác nhau → jobId khác nhau', () => {
    const a = buildJobId('publish-post', {
      platformPostId: 'pp_1',
      workspaceId: 'ws_1',
      correlationId: 'r',
    });
    const b = buildJobId('publish-post', {
      platformPostId: 'pp_2',
      workspaceId: 'ws_1',
      correlationId: 'r',
    });
    expect(a).not.toBe(b);
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
