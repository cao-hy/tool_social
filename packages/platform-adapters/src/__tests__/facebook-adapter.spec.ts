import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentFixtureAdapter } from '../dev/development-fixture.adapter';
import { FacebookPagesAdapter } from '../facebook/facebook.adapter';
import { createRuntimeAdapterRegistry } from '../registry-factory';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('FacebookPagesAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tạo authorization URL bằng Facebook OAuth dialog', () => {
    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/facebook/callback',
        state: 'state-123',
        scopes: ['pages_show_list', 'pages_read_engagement'],
      }),
    );

    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v24.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/v1/oauth/facebook/callback',
    );
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('return_scopes')).toBe('true');
  });

  it('dùng Facebook Login for Business config_id khi được cấu hình', () => {
    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
      loginConfigId: 'config-123',
    });

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/facebook/callback',
        state: 'state-123',
        scopes: ['pages_show_list', 'pages_read_user_content'],
      }),
    );

    expect(url.searchParams.get('config_id')).toBe('config-123');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.get('return_scopes')).toBe('true');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('đổi authorization code thành Page access token đầu tiên quản lý được', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/oauth/access_token')) {
        if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
          return jsonResponse({
            access_token: 'long-lived-user-token',
            token_type: 'bearer',
            expires_in: 5_184_000,
          });
        }

        return jsonResponse({
          access_token: 'short-lived-user-token',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }

      if (url.pathname.endsWith('/me/accounts')) {
        return jsonResponse({
          data: [
            {
              id: 'page-1',
              name: 'Main Page',
              access_token: 'page-access-token',
              tasks: ['CREATE_CONTENT'],
            },
          ],
        });
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    const token = await adapter.exchangeCodeForToken(
      'oauth-code',
      'http://localhost:4000/api/v1/oauth/facebook/callback',
    );

    expect(token.accessToken).toBe('page-access-token');
    expect(token.refreshToken).toBeUndefined();
    expect(token.scopes).toEqual([
      'pages_show_list',
      'pages_read_engagement',
      'pages_read_user_content',
      'pages_manage_posts',
      'pages_manage_engagement',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('map profile Page từ token đã lưu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 'page-1',
          name: 'Main Page',
          username: 'main.page',
          link: 'https://www.facebook.com/main.page',
          fan_count: 123,
          picture: { data: { url: 'https://example.test/avatar.png' } },
        }),
      ),
    );

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    await expect(
      adapter.getAccountProfile({
        accessToken: 'page-access-token',
        externalAccountId: 'pending',
        correlationId: 'test',
      }),
    ).resolves.toEqual({
      externalAccountId: 'page-1',
      name: 'Main Page',
      username: 'main.page',
      avatarUrl: 'https://example.test/avatar.png',
      profileUrl: 'https://www.facebook.com/main.page',
      followersCount: 123,
    });
  });

  it('publish text/link post lên Page feed', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      expect(String(input)).toBe('https://graph.facebook.com/v24.0/page-1/feed');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('access_token=page-access-token');
      expect(String(init?.body)).toContain('message=hello');
      expect(String(init?.body)).toContain('link=https%3A%2F%2Fexample.test%2Flaunch');
      return jsonResponse({ id: 'page-1_post-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    await expect(
      adapter.publishPost(
        { accessToken: 'page-access-token', externalAccountId: 'page-1', correlationId: 'test' },
        { caption: 'hello', linkUrl: 'https://example.test/launch', media: [] },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'page-1_post-1',
      externalUrl: 'https://www.facebook.com/page-1_post-1',
    });
  });

  it('publish post có một ảnh bằng Page photos endpoint', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe('POST');

      if (url === 'https://graph.facebook.com/v24.0/page-1/photos?access_token=page-access-token') {
        expect(init?.headers).toMatchObject({
          'content-type': expect.stringContaining('multipart/form-data; boundary='),
        });
        const body = init?.body as Uint8Array;
        expect(body).toBeInstanceOf(Uint8Array);
        expect((init?.headers as Record<string, string>)['content-length']).toBe(
          String(body.byteLength),
        );
        const text = new TextDecoder().decode(body);
        expect(text).toContain('name="caption"');
        expect(text).toContain('hello');
        expect(text).toContain('name="published"');
        expect(text).toContain('name="source"; filename="image.jpg"');
        expect(text).toContain('Content-Type: image/jpeg');
        return jsonResponse({ id: 'photo-1', post_id: 'page-1_post-1' });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    await expect(
      adapter.publishPost(
        { accessToken: 'page-access-token', externalAccountId: 'page-1', correlationId: 'test' },
        {
          caption: 'hello',
          media: [
            {
              type: 'IMAGE',
              url: 'workspaces/ws/media/image.jpg',
              bytes: new Uint8Array([1, 2, 3]),
              mimeType: 'image/jpeg',
              sizeBytes: 3,
            },
          ],
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'page-1_post-1',
      externalUrl: 'https://www.facebook.com/page-1_post-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('publish video kèm thumbnail bằng Page videos endpoint', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe('POST');

      if (
        url ===
        'https://graph-video.facebook.com/v24.0/page-1/videos?access_token=page-access-token'
      ) {
        expect(init?.headers).toMatchObject({
          'content-type': expect.stringContaining('multipart/form-data; boundary='),
        });
        const body = init?.body as Uint8Array;
        expect(body).toBeInstanceOf(Uint8Array);
        const text = new TextDecoder().decode(body);
        expect(text).toContain('name="title"');
        expect(text).toContain('video title');
        expect(text).toContain('name="description"');
        expect(text).toContain('hello');
        expect(text).toContain('name="thumb"; filename="cover.jpg"');
        expect(text).toContain('Content-Type: image/jpeg');
        expect(text).toContain('name="source"; filename="video.mp4"');
        expect(text).toContain('Content-Type: video/mp4');
        return jsonResponse({ id: 'video-1' });
      }

      if (
        url === 'https://graph.facebook.com/v24.0/video-1/thumbnails?access_token=page-access-token'
      ) {
        expect(init?.headers).toMatchObject({
          'content-type': expect.stringContaining('multipart/form-data; boundary='),
        });
        const body = init?.body as Uint8Array;
        expect(body).toBeInstanceOf(Uint8Array);
        const text = new TextDecoder().decode(body);
        expect(text).toContain('name="source"; filename="thumbnail.jpg"');
        expect(text).toContain('Content-Type: image/jpeg');
        expect(text).toContain('name="is_preferred"');
        expect(text).toContain('true');
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    await expect(
      adapter.publishPost(
        { accessToken: 'page-access-token', externalAccountId: 'page-1', correlationId: 'test' },
        {
          title: 'video title',
          caption: 'hello',
          media: [
            {
              type: 'VIDEO',
              url: 'workspaces/ws/media/video.mp4',
              bytes: new Uint8Array([1, 2, 3]),
              mimeType: 'video/mp4',
              sizeBytes: 3,
            },
          ],
          thumbnail: {
            type: 'IMAGE',
            url: 'workspaces/ws/media/cover.jpg',
            bytes: new Uint8Array([4, 5, 6]),
            mimeType: 'image/jpeg',
            sizeBytes: 3,
          },
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'video-1',
      externalUrl: 'https://www.facebook.com/video-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('đọc comments của một Page post qua Graph API comments edge', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://graph.facebook.com');
      expect(url.pathname).toBe('/v24.0/page-1_post-1/comments');
      expect(url.searchParams.get('access_token')).toBe('page-access-token');
      expect(url.searchParams.get('filter')).toBe('stream');
      expect(url.searchParams.get('after')).toBe('cursor-1');
      expect(url.searchParams.get('since')).toBe('1710000000');
      expect(url.searchParams.get('fields')).toContain('parent{id}');

      return jsonResponse({
        data: [
          {
            id: 'comment-1',
            message: 'hello',
            created_time: '2024-03-09T16:00:00+0000',
            from: { id: 'user-1', name: 'Reader' },
            like_count: 2,
            is_hidden: false,
          },
          {
            id: 'comment-2',
            message: 'page reply',
            created_time: '2024-03-09T16:01:00+0000',
            from: { id: 'page-1', name: 'Main Page' },
            parent: { id: 'comment-1' },
          },
        ],
        paging: { cursors: { after: 'cursor-2' }, next: 'https://graph.facebook.com/next' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    await expect(
      adapter.getComments(
        { accessToken: 'page-access-token', externalAccountId: 'page-1', correlationId: 'test' },
        {
          externalPostId: 'page-1_post-1',
          cursor: 'cursor-1',
          since: new Date('2024-03-09T16:00:00.000Z'),
        },
      ),
    ).resolves.toMatchObject({
      nextCursor: 'cursor-2',
      hasMore: true,
      items: [
        {
          externalCommentId: 'comment-1',
          externalPostId: 'page-1_post-1',
          authorExternalId: 'user-1',
          authorName: 'Reader',
          message: 'hello',
          likeCount: 2,
          isHidden: false,
          isFromOwner: false,
        },
        {
          externalCommentId: 'comment-2',
          parentExternalCommentId: 'comment-1',
          isFromOwner: true,
        },
      ],
    });
  });

  it('đọc metrics Facebook Page post từ engagement fields và insights', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://graph.facebook.com');
      expect(url.searchParams.get('access_token')).toBe('page-access-token');

      if (url.pathname === '/v24.0/page-1_post-1') {
        expect(url.searchParams.get('fields')).toContain('reactions.limit(0).summary(true)');
        expect(url.searchParams.get('fields')).toContain('comments.limit(0).summary(true)');
        expect(url.searchParams.get('fields')).toContain('shares');
        return jsonResponse({
          reactions: { summary: { total_count: 12 } },
          comments: { summary: { total_count: 3 } },
          shares: { count: 2 },
        });
      }

      if (url.pathname === '/v24.0/page-1_post-1/insights') {
        expect(url.searchParams.get('period')).toBe('lifetime');
        const metric = url.searchParams.get('metric');
        const values: Record<string, unknown> = {
          post_media_view: 150,
          post_total_media_view_unique: 90,
          post_impressions: 100,
          post_impressions_unique: 80,
          post_engaged_users: 20,
          post_clicks: 7,
          post_reactions_by_type_total: { like: 10, love: 2 },
          post_video_avg_time_watched: 5,
        };
        if (!metric || !(metric in values)) {
          return jsonResponse({ data: [] });
        }
        return jsonResponse({
          data: [{ name: metric, values: [{ value: values[metric] }] }],
        });
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    const metrics = await adapter.getPostMetrics(
      { accessToken: 'page-access-token', externalAccountId: 'page-1', correlationId: 'test' },
      'page-1_post-1',
    );

    expect(metrics.likes).toEqual({ value: 12, source: 'PLATFORM_API' });
    expect(metrics.comments).toEqual({ value: 3, source: 'PLATFORM_API' });
    expect(metrics.shares).toEqual({ value: 2, source: 'PLATFORM_API' });
    expect(metrics.views).toEqual({ value: 150, source: 'PLATFORM_API' });
    expect(metrics.impressions).toEqual({ value: 100, source: 'PLATFORM_API' });
    expect(metrics.reach).toEqual({ value: 90, source: 'PLATFORM_API' });
    expect(metrics.engagement).toEqual({ value: 20, source: 'PLATFORM_API' });
    expect(metrics.engagementRate.value).toBeCloseTo(18.888);
    expect(metrics.raw).toMatchObject({
      insights: {
        post_media_view: 150,
        post_reactions_by_type_total: { like: 10, love: 2 },
      },
      normalized: {
        clicks: 7,
        reactionBreakdown: { like: 10, love: 2 },
      },
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });

  it('giữ metrics engagement khi Facebook insights bị thiếu quyền', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/v24.0/page-1_post-1') {
        return jsonResponse({
          reactions: { summary: { total_count: 4 } },
          comments: { summary: { total_count: 1 } },
          shares: { count: 1 },
        });
      }

      if (url.pathname === '/v24.0/page-1_post-1/insights') {
        return jsonResponse(
          {
            error: {
              message: '(#100) Missing Permission',
              type: 'OAuthException',
              code: 100,
            },
          },
          { status: 400 },
        );
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    const metrics = await adapter.getPostMetrics(
      {
        accessToken: 'page-access-token',
        externalAccountId: 'page-1',
        correlationId: 'test',
        logger,
      },
      'page-1_post-1',
    );

    expect(metrics.likes.value).toBe(4);
    expect(metrics.comments.value).toBe(1);
    expect(metrics.shares.value).toBe(1);
    expect(metrics.engagement).toEqual({ value: 6, source: 'PLATFORM_API' });
    expect(metrics.impressions.source).toBe('UNSUPPORTED');
    expect(metrics.reach.source).toBe('UNSUPPORTED');
    expect(logger.debug).toHaveBeenCalledWith(
      'Facebook post insights unavailable',
      expect.objectContaining({ externalPostId: 'page-1_post-1' }),
    );
  });

  it('reply comment bằng Page access token', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      expect(String(input)).toBe('https://graph.facebook.com/v24.0/comment-1/comments');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('access_token=page-access-token');
      expect(String(init?.body)).toContain('message=C%E1%BA%A3m+%C6%A1n+b%E1%BA%A1n');
      return jsonResponse({ id: 'reply-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new FacebookPagesAdapter({
      appId: 'app-id',
      appSecret: 'app-secret',
      apiVersion: 'v24.0',
    });

    await expect(
      adapter.replyToComment(
        { accessToken: 'page-access-token', externalAccountId: 'page-1', correlationId: 'test' },
        'comment-1',
        'Cảm ơn bạn',
      ),
    ).resolves.toMatchObject({
      externalReplyId: 'reply-1',
      sentAt: expect.any(Date),
    });
  });
});

describe('createRuntimeAdapterRegistry', () => {
  it('ưu tiên Facebook adapter thật khi cấu hình đủ credential', () => {
    const registry = createRuntimeAdapterRegistry({
      nodeEnv: 'development',
      facebook: {
        appId: 'app-id',
        appSecret: 'app-secret',
        apiVersion: 'v24.0',
      },
    });

    expect(registry.get('FACEBOOK')).toBeInstanceOf(FacebookPagesAdapter);
    expect(registry.get('INSTAGRAM')).toBeInstanceOf(DevelopmentFixtureAdapter);
  });

  it('báo lỗi rõ khi Facebook config bị thiếu một phần', () => {
    expect(() =>
      createRuntimeAdapterRegistry({
        nodeEnv: 'development',
        facebook: {
          appId: 'app-id',
          appSecret: 'app-secret',
        },
      }),
    ).toThrow(/FACEBOOK_API_VERSION/);
  });
});
