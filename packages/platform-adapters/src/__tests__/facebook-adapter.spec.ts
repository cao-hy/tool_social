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
      'pages_manage_posts',
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
        const body = init?.body as FormData;
        expect(body.get('caption')).toBe('hello');
        expect(body.get('published')).toBe('1');
        expect(body.get('source')).toBeInstanceOf(Blob);
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
