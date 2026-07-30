import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstagramAdapter } from '../instagram/instagram.adapter';
import { normalizeInstagramError } from '../instagram/instagram.errors';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('InstagramAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createAdapter() {
    return new InstagramAdapter({
      appId: 'ig-app',
      appSecret: 'ig-secret',
      apiVersion: 'v24.0',
    });
  }

  it('authorization URL xin scope comment và insights cho CRUD thật', () => {
    const adapter = createAdapter();

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/instagram/callback',
        state: 'state-123',
        scopes: [],
      }),
    );

    expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
    expect(url.searchParams.get('scope')).toContain('instagram_manage_comments');
    expect(url.searchParams.get('scope')).toContain('instagram_manage_insights');
  });

  it('map lỗi Missing Permission thành PERMISSION_DENIED rõ nguyên nhân', () => {
    const error = normalizeInstagramError({
      status: 400,
      payload: {
        error: {
          message: '(#100) Missing Permission',
          type: 'OAuthException',
          code: 100,
        },
      },
    });

    expect(error.kind).toBe('PERMISSION_DENIED');
    expect(error.message).toContain('instagram_manage_comments');
    expect(error.platformCode).toBe('100');
  });

  it('xóa media Instagram bằng DELETE /{ig_media_id}', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await createAdapter().deletePost(
      {
        accessToken: 'page-token',
        externalAccountId: 'ig-user-1',
        correlationId: 'corr-1',
      },
      'media-1',
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(new URL(String(url)).pathname).toBe('/v24.0/media-1');
    expect(new URL(String(url)).searchParams.get('access_token')).toBe('page-token');
    expect(init.method).toBe('DELETE');
  });

  it('đọc danh sách media Instagram của account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: 'media-1',
              caption: 'hello',
              media_type: 'IMAGE',
              media_url: 'https://cdn.test/image.jpg',
              permalink: 'https://instagram.com/p/media-1',
              timestamp: '2026-07-30T10:00:00+0000',
            },
          ],
          paging: { cursors: { after: 'next' }, next: 'https://graph.test/next' },
        }),
      ),
    );

    const page = await createAdapter().getPosts(
      {
        accessToken: 'page-token',
        externalAccountId: 'ig-user-1',
        correlationId: 'corr-1',
      },
      { limit: 10 },
    );

    expect(page.items[0]).toMatchObject({
      externalPostId: 'media-1',
      caption: 'hello',
      mediaType: 'IMAGE',
      externalUrl: 'https://instagram.com/p/media-1',
    });
    expect(page.nextCursor).toBe('next');
    expect(page.hasMore).toBe(true);
  });

  it('đọc like/comment count và insight metric khả dụng', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/media-1') && !url.pathname.endsWith('/insights')) {
        return jsonResponse({
          id: 'media-1',
          like_count: 12,
          comments_count: 3,
        });
      }
      if (url.pathname.endsWith('/media-1/insights')) {
        const metric = url.searchParams.get('metric');
        if (metric === 'reach')
          return jsonResponse({ data: [{ name: 'reach', values: [{ value: 50 }] }] });
        if (metric === 'impressions') {
          return jsonResponse({ data: [{ name: 'impressions', values: [{ value: 80 }] }] });
        }
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const metrics = await createAdapter().getPostMetrics(
      {
        accessToken: 'page-token',
        externalAccountId: 'ig-user-1',
        correlationId: 'corr-1',
      },
      'media-1',
    );

    expect(metrics.likes.value).toBe(12);
    expect(metrics.comments.value).toBe(3);
    expect(metrics.reach.value).toBe(50);
    expect(metrics.impressions.value).toBe(80);
  });

  it('đọc comment và reply comment Instagram', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/media-1/comments')) {
        return jsonResponse({
          data: [
            {
              id: 'comment-1',
              text: 'Nice',
              username: 'viewer',
              like_count: 2,
              timestamp: '2026-07-30T10:00:00+0000',
            },
          ],
        });
      }
      if (url.pathname.endsWith('/comment-1/replies') && init?.method === 'POST') {
        return jsonResponse({ id: 'reply-1' });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAdapter();
    const comments = await adapter.getComments?.(
      {
        accessToken: 'page-token',
        externalAccountId: 'ig-user-1',
        correlationId: 'corr-1',
      },
      { externalPostId: 'media-1' },
    );
    const reply = await adapter.replyToComment?.(
      {
        accessToken: 'page-token',
        externalAccountId: 'ig-user-1',
        correlationId: 'corr-1',
      },
      'comment-1',
      'Thanks',
    );

    expect(comments?.items[0]).toMatchObject({
      externalCommentId: 'comment-1',
      externalPostId: 'media-1',
      message: 'Nice',
      likeCount: 2,
    });
    expect(reply?.externalReplyId).toBe('reply-1');
  });
});
