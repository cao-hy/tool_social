import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentFixtureAdapter } from '../dev/development-fixture.adapter';
import { PinterestAdapter } from '../pinterest/pinterest.adapter';
import { createRuntimeAdapterRegistry } from '../registry-factory';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('PinterestAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tạo authorization URL bằng Pinterest OAuth', () => {
    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/pinterest/callback',
        state: 'state-123',
        scopes: ['boards:read', 'pins:write'],
      }),
    );

    expect(url.origin).toBe('https://www.pinterest.com');
    expect(url.pathname).toBe('/oauth/');
    expect(url.searchParams.get('client_id')).toBe('pin-app');
    expect(url.searchParams.get('scope')).toBe('boards:read,pins:write');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('OAuth scope mặc định có quyền đọc user account', () => {
    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/pinterest/callback',
        state: 'state-123',
        scopes: [],
      }),
    );

    expect(url.searchParams.get('scope')?.split(',')).toContain('user_accounts:read');
  });

  it('đổi code thành token và chọn/tạo board mặc định', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.pinterest.com');
      if (url.pathname === '/v5/oauth/token') {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          authorization: `Basic ${Buffer.from('pin-app:pin-secret').toString('base64')}`,
        });
        return jsonResponse({
          access_token: 'pin-access',
          refresh_token: 'pin-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'user_accounts:read,boards:read,pins:write',
        });
      }
      if (url.pathname === '/v5/user_account') {
        return jsonResponse({
          id: 'user-1',
          username: 'socialhub',
          business_name: null,
          profile_image: '',
          website_url: null,
          account_type: 'BUSINESS',
          follower_count: 7,
        });
      }
      if (url.pathname === '/v5/boards' && init?.method !== 'POST') {
        return jsonResponse({ items: [], bookmark: null });
      }
      if (url.pathname === '/v5/boards' && init?.method === 'POST') {
        expect(String(init.body)).toContain('"name":"SocialHub"');
        return jsonResponse({ id: 'board-1', name: 'SocialHub', privacy: 'PUBLIC' });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    const token = await adapter.exchangeCodeForToken(
      'oauth-code',
      'http://localhost:4000/api/v1/oauth/pinterest/callback',
    );

    expect(token.accessToken).toBe('pin-access');
    expect(token.refreshToken).toBe('pin-refresh');
    expect(token.scopes).toContain('user_accounts:read');
    expect(token.accountProfile).toMatchObject({
      externalAccountId: 'user-1',
      externalPageId: 'board-1',
      name: 'socialhub / SocialHub',
    });
  });

  it('không làm fail OAuth khi Pinterest báo trùng tên board mặc định', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v5/oauth/token') {
        return jsonResponse({
          access_token: 'pin-access',
          refresh_token: 'pin-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'user_accounts:read,boards:read,boards:write,pins:write',
        });
      }
      if (url.pathname === '/v5/user_account') {
        return jsonResponse({
          id: 'user-1',
          username: 'socialhub',
        });
      }
      if (url.pathname === '/v5/boards' && init?.method !== 'POST') {
        return jsonResponse({ items: [], bookmark: null });
      }
      if (url.pathname === '/v5/boards' && init?.method === 'POST') {
        const body = String(init.body);
        if (body.includes('"name":"SocialHub"')) {
          return jsonResponse(
            { code: 58, message: 'Try a different name. You already have a board with this name!' },
            { status: 400 },
          );
        }
        expect(body).toContain('"name":"SocialHub Sandbox"');
        return jsonResponse({ id: 'board-fallback', name: 'SocialHub Sandbox', privacy: 'PUBLIC' });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    await expect(
      adapter.exchangeCodeForToken(
        'oauth-code',
        'http://localhost:4000/api/v1/oauth/pinterest/callback',
      ),
    ).resolves.toMatchObject({
      accountProfile: {
        externalPageId: 'board-fallback',
        name: 'socialhub / SocialHub Sandbox',
      },
    });
  });

  it('publish ảnh lên Pinterest bằng image_base64', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v5/pins');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer pin-access' });
      expect(String(init?.body)).toContain('"source_type":"image_base64"');
      expect(String(init?.body)).toContain('"data":"AQID"');
      return jsonResponse({ id: 'pin-1', created_at: '2026-07-28T01:00:00Z' }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
      environment: 'production',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'pin-access',
          externalAccountId: 'user-1',
          externalPageId: 'board-1',
          correlationId: 'test',
        },
        {
          title: 'Pin title',
          caption: 'Pin description',
          linkUrl: 'https://example.com',
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
      externalPostId: 'pin-1',
      externalUrl: 'https://www.pinterest.com/pin/pin-1/',
    });
  });

  it('đọc Pins trên board và map sang bài đăng chung', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v5/boards/board-1/pins');
      expect(url.searchParams.get('bookmark')).toBe('cursor-1');
      expect(url.searchParams.get('page_size')).toBe('50');
      expect(url.searchParams.get('pin_metrics')).toBe('true');
      return jsonResponse({
        bookmark: 'cursor-2',
        items: [
          {
            id: 'pin-1',
            title: 'Summer board',
            description: 'Fresh Pin',
            created_at: '2026-07-30T08:00:00Z',
            creative_type: 'REGULAR',
            media: {
              media_type: 'image',
              images: {
                '600x': {
                  width: 600,
                  height: 900,
                  url: 'https://i.pinimg.com/600x/pin-1.jpg',
                },
              },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    await expect(
      adapter.getPosts(
        {
          accessToken: 'pin-access',
          externalAccountId: 'user-1',
          externalPageId: 'board-1',
          correlationId: 'test',
        },
        { cursor: 'cursor-1', limit: 50 },
      ),
    ).resolves.toMatchObject({
      items: [
        {
          externalPostId: 'pin-1',
          externalUrl: 'https://www.pinterest.com/pin/pin-1/',
          caption: 'Fresh Pin',
          title: 'Summer board',
          mediaType: 'IMAGE',
          thumbnailUrl: 'https://i.pinimg.com/600x/pin-1.jpg',
        },
      ],
      nextCursor: 'cursor-2',
      hasMore: true,
    });
  });

  it('sửa metadata Pin qua PATCH /pins/{pin_id}', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v5/pins/pin-1');
      expect(init?.method).toBe('PATCH');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer pin-access' });
      expect(String(init?.body)).toContain('"title":"Updated Pin"');
      expect(String(init?.body)).toContain('"description":"Updated description\\n\\n#launch"');
      expect(String(init?.body)).toContain('"board_section_id":"section-1"');
      return jsonResponse({ id: 'pin-1', title: 'Updated Pin' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    await expect(
      adapter.editPost(
        {
          accessToken: 'pin-access',
          externalAccountId: 'user-1',
          externalPageId: 'board-1',
          correlationId: 'test',
        },
        'pin-1',
        {
          title: 'Updated Pin',
          description: 'Updated description',
          linkUrl: 'https://example.com/pin',
          hashtags: ['launch'],
          options: { boardSectionId: 'section-1', altText: 'Updated alt' },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('xóa Pin qua DELETE /pins/{pin_id}', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v5/pins/pin-1');
      expect(init?.method).toBe('DELETE');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer pin-access' });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    await expect(
      adapter.deletePost(
        {
          accessToken: 'pin-access',
          externalAccountId: 'user-1',
          correlationId: 'test',
        },
        'pin-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('đọc metric Pin từ analytics và pin_metrics lifetime', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/v5/pins/pin-1') {
        expect(url.searchParams.get('pin_metrics')).toBe('true');
        return jsonResponse({
          id: 'pin-1',
          pin_metrics: {
            lifetime_metrics: {
              impression: 90,
              reaction: 4,
              comment: 3,
            },
          },
        });
      }
      if (url.pathname === '/v5/pins/pin-1/analytics') {
        expect(url.searchParams.get('metric_types')).toContain('IMPRESSION');
        expect(url.searchParams.get('split_field')).toBe('NO_SPLIT');
        return jsonResponse({
          pin_1: {
            summary_metrics: {
              IMPRESSION: 100,
              SAVE: 8,
              PIN_CLICK: 12,
              OUTBOUND_CLICK: 5,
              ENGAGEMENT: 25,
              TOTAL_REACTIONS: 6,
              VIDEO_MRC_VIEW: 11,
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
    });

    await expect(
      adapter.getPostMetrics(
        {
          accessToken: 'pin-access',
          externalAccountId: 'user-1',
          correlationId: 'test',
        },
        'pin-1',
      ),
    ).resolves.toMatchObject({
      views: { value: 11, source: 'PLATFORM_API' },
      likes: { value: 6, source: 'PLATFORM_API' },
      comments: { value: 3, source: 'PLATFORM_API' },
      impressions: { value: 100, source: 'PLATFORM_API' },
      saves: { value: 8, source: 'PLATFORM_API' },
      engagement: { value: 25, source: 'PLATFORM_API' },
    });
  });

  it('publish video lên Pinterest qua media upload flow', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v5/media') {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('"media_type":"video"');
        return jsonResponse({
          media_id: 'media-1',
          upload_url: 'https://upload.pinterest.test/video',
          upload_parameters: { key: 'uploads/video.mp4', policy: 'policy-1' },
        });
      }
      if (url.origin === 'https://upload.pinterest.test') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v5/media/media-1') {
        return jsonResponse({ media_id: 'media-1', status: 'succeeded' });
      }
      if (url.pathname === '/v5/pins') {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('"source_type":"video_id"');
        expect(String(init?.body)).toContain('"media_id":"media-1"');
        expect(String(init?.body)).toContain('"cover_image_url":"https://cdn.test/cover.jpg"');
        return jsonResponse({ id: 'pin-video-1' }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
      environment: 'production',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'pin-access',
          externalAccountId: 'user-1',
          externalPageId: 'board-1',
          correlationId: 'test',
        },
        {
          title: 'Video Pin',
          caption: 'Watch this',
          media: [
            {
              type: 'VIDEO',
              url: 'workspaces/ws/media/video.mp4',
              bytes: new Uint8Array([1, 2, 3]),
              mimeType: 'video/mp4',
              sizeBytes: 3,
            },
            {
              type: 'IMAGE',
              url: 'https://cdn.test/cover.jpg',
              bytes: new Uint8Array([4, 5, 6]),
              mimeType: 'image/jpeg',
              sizeBytes: 3,
            },
          ],
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'pin-video-1',
      externalUrl: 'https://www.pinterest.com/pin/pin-video-1/',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('chặn video Pin trong Pinterest sandbox', () => {
    const adapter = new PinterestAdapter({
      appId: 'pin-app',
      appSecret: 'pin-secret',
      environment: 'sandbox',
    });

    expect(
      adapter.validatePost({
        title: 'Video Pin',
        media: [
          {
            type: 'VIDEO',
            url: 'workspaces/ws/media/video.mp4',
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'video/mp4',
            sizeBytes: 3,
          },
          {
            type: 'IMAGE',
            url: 'https://cdn.test/cover.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 3,
          },
        ],
      }),
    ).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ field: 'media.video' })],
    });
  });
});

describe('createRuntimeAdapterRegistry Pinterest', () => {
  it('ưu tiên Pinterest adapter thật khi cấu hình đủ credential', () => {
    const registry = createRuntimeAdapterRegistry({
      nodeEnv: 'development',
      pinterest: {
        appId: 'pin-app',
        appSecret: 'pin-secret',
      },
    });

    expect(registry.get('PINTEREST')).toBeInstanceOf(PinterestAdapter);
    expect(registry.get('FACEBOOK')).toBeInstanceOf(DevelopmentFixtureAdapter);
  });

  it('local development dùng Pinterest sandbox API mặc định', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api-sandbox.pinterest.com');
      if (url.pathname === '/v5/oauth/token') {
        return jsonResponse({ access_token: 'pin-access' });
      }
      if (url.pathname === '/v5/user_account') {
        return jsonResponse({ id: 'user-1', username: 'socialhub' });
      }
      if (url.pathname === '/v5/boards') {
        return jsonResponse({ items: [{ id: 'board-1', name: 'SocialHub' }] });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = createRuntimeAdapterRegistry({
      nodeEnv: 'development',
      pinterest: {
        appId: 'pin-app',
        appSecret: 'pin-secret',
      },
    });

    await expect(
      registry
        .get('PINTEREST')
        .exchangeCodeForToken(
          'oauth-code',
          'http://localhost:4000/api/v1/oauth/pinterest/callback',
        ),
    ).resolves.toMatchObject({ accessToken: 'pin-access' });
  });
});
