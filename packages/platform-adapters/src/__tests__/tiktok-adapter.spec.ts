import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentFixtureAdapter } from '../dev/development-fixture.adapter';
import { createRuntimeAdapterRegistry } from '../registry-factory';
import { TikTokAdapter } from '../tiktok/tiktok.adapter';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('TikTokAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tạo authorization URL bằng TikTok OAuth v2', () => {
    const adapter = new TikTokAdapter({
      clientKey: 'tt-key',
      clientSecret: 'tt-secret',
    });

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/tiktok/callback',
        state: 'state-123',
        scopes: [],
      }),
    );

    expect(url.origin).toBe('https://www.tiktok.com');
    expect(url.pathname).toBe('/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('tt-key');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/v1/oauth/tiktok/callback',
    );
    expect(url.searchParams.get('scope')?.split(',')).toEqual([
      'user.info.basic',
      'video.upload',
      'video.publish',
      'video.list',
    ]);
  });

  it('đổi code thành token và lấy TikTok profile', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/oauth/token/') {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('grant_type=authorization_code');
        return jsonResponse({
          access_token: 'tt-access',
          expires_in: 86400,
          open_id: 'open-1',
          refresh_expires_in: 31536000,
          refresh_token: 'tt-refresh',
          scope: 'user.info.basic,video.upload,video.publish,video.list',
          token_type: 'Bearer',
        });
      }
      if (url.pathname === '/v2/user/info/') {
        expect(url.searchParams.get('fields')).toContain('open_id');
        return jsonResponse({
          data: {
            user: {
              open_id: 'open-1',
              display_name: 'TikTok Creator',
              avatar_url: 'https://cdn.test/avatar.jpg',
            },
          },
          error: { code: 'ok', message: '' },
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TikTokAdapter({
      clientKey: 'tt-key',
      clientSecret: 'tt-secret',
    });

    await expect(
      adapter.exchangeCodeForToken(
        'oauth-code',
        'http://localhost:4000/api/v1/oauth/tiktok/callback',
      ),
    ).resolves.toMatchObject({
      accessToken: 'tt-access',
      refreshToken: 'tt-refresh',
      accountProfile: {
        externalAccountId: 'open-1',
        name: 'TikTok Creator',
      },
    });
  });

  it('publish video TikTok bằng Direct Post FILE_UPLOAD', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/post/publish/creator_info/query/') {
        return jsonResponse({
          data: {
            creator_username: 'creator',
            creator_nickname: 'Creator',
            privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
            comment_disabled: false,
            duet_disabled: false,
            stitch_disabled: false,
            max_video_post_duration_sec: 300,
          },
          error: { code: 'ok', message: '' },
        });
      }
      if (url.pathname === '/v2/post/publish/video/init/') {
        expect(String(init?.body)).toContain('"privacy_level":"PUBLIC_TO_EVERYONE"');
        expect(String(init?.body)).toContain('"video_size":3');
        return jsonResponse({
          data: {
            publish_id: 'v_pub_file~123',
            upload_url: 'https://open-upload.tiktokapis.com/upload/?upload_id=1',
          },
          error: { code: 'ok', message: '' },
        });
      }
      if (url.origin === 'https://open-upload.tiktokapis.com') {
        expect(init?.method).toBe('PUT');
        expect(init?.headers).toMatchObject({
          'content-type': 'video/mp4',
          'content-length': '3',
          'content-range': 'bytes 0-2/3',
        });
        expect(init?.body).toBeInstanceOf(Uint8Array);
        expect(init?.body).toEqual(new Uint8Array([1, 2, 3]));
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TikTokAdapter({
      clientKey: 'tt-key',
      clientSecret: 'tt-secret',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'tt-access',
          externalAccountId: 'open-1',
          correlationId: 'test',
        },
        {
          caption: 'Demo TikTok',
          hashtags: ['demo'],
          media: [
            {
              type: 'VIDEO',
              url: 'workspaces/ws/media/video.mp4',
              bytes: new Uint8Array([1, 2, 3]),
              mimeType: 'video/mp4',
              sizeBytes: 3,
            },
          ],
          options: {
            postMode: 'DIRECT_POST',
            privacyLevel: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          },
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'v_pub_file~123',
      pending: true,
    });
  });

  it('upload video TikTok vào Inbox bằng FILE_UPLOAD', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/post/publish/inbox/video/init/') {
        expect(String(init?.body)).toContain('"video_size":3');
        return jsonResponse({
          data: {
            publish_id: 'v_inbox_file~123',
            upload_url: 'https://open-upload.tiktokapis.com/upload/?upload_id=inbox',
          },
          error: { code: 'ok', message: '' },
        });
      }
      if (url.origin === 'https://open-upload.tiktokapis.com') {
        expect(init?.method).toBe('PUT');
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TikTokAdapter({
      clientKey: 'tt-key',
      clientSecret: 'tt-secret',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'tt-access',
          externalAccountId: 'open-1',
          correlationId: 'test',
        },
        {
          caption: 'Upload later',
          media: [
            {
              type: 'VIDEO',
              url: 'workspaces/ws/media/video.mp4',
              bytes: new Uint8Array([1, 2, 3]),
              mimeType: 'video/mp4',
              sizeBytes: 3,
            },
          ],
          options: { postMode: 'MEDIA_UPLOAD' },
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'v_inbox_file~123',
      pending: true,
    });
  });

  it('publish TikTok photo post bằng URL public đã verify', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/post/publish/creator_info/query/') {
        return jsonResponse({
          data: {
            privacy_level_options: ['SELF_ONLY'],
          },
          error: { code: 'ok', message: '' },
        });
      }
      if (url.pathname === '/v2/post/publish/content/init/') {
        expect(String(init?.body)).toContain('"media_type":"PHOTO"');
        expect(String(init?.body)).toContain('"post_mode":"DIRECT_POST"');
        expect(String(init?.body)).toContain('"photo_images":["https://media.example/photo.jpg"]');
        return jsonResponse({
          data: {
            publish_id: 'p_pub_url~123',
          },
          error: { code: 'ok', message: '' },
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TikTokAdapter({
      clientKey: 'tt-key',
      clientSecret: 'tt-secret',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'tt-access',
          externalAccountId: 'open-1',
          correlationId: 'test',
        },
        {
          caption: 'Photo TikTok',
          media: [
            {
              type: 'IMAGE',
              url: 'https://media.example/photo.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 3000,
            },
          ],
          options: {
            postMode: 'DIRECT_POST',
            privacyLevel: 'SELF_ONLY',
            consentConfirmed: true,
          },
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'p_pub_url~123',
      pending: true,
    });
  });

  it('chặn bài TikTok không đúng 1 video', () => {
    const adapter = new TikTokAdapter({
      clientKey: 'tt-key',
      clientSecret: 'tt-secret',
    });

    expect(
      adapter.validatePost({
        media: [],
      }),
    ).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ field: 'media' })],
    });
  });
});

describe('createRuntimeAdapterRegistry TikTok', () => {
  it('ưu tiên TikTok adapter thật khi cấu hình đủ credential', () => {
    const registry = createRuntimeAdapterRegistry({
      nodeEnv: 'development',
      tiktok: {
        clientKey: 'tt-key',
        clientSecret: 'tt-secret',
      },
    });

    expect(registry.get('TIKTOK')).toBeInstanceOf(TikTokAdapter);
    expect(registry.get('FACEBOOK')).toBeInstanceOf(DevelopmentFixtureAdapter);
  });
});
