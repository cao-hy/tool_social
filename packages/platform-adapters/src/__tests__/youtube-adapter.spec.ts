import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentFixtureAdapter } from '../dev/development-fixture.adapter';
import { createRuntimeAdapterRegistry } from '../registry-factory';
import { YouTubeAdapter } from '../youtube/youtube.adapter';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('YouTubeAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tạo authorization URL bằng Google OAuth server-side flow', () => {
    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    const url = new URL(
      adapter.buildAuthorizationUrl({
        redirectUri: 'http://localhost:4000/api/v1/oauth/youtube/callback',
        state: 'state-123',
        scopes: [],
      }),
    );

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('youtube-client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/v1/oauth/youtube/callback',
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl',
    ]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('đổi code thành token và lấy channel profile', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href === 'https://oauth2.googleapis.com/token') {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('grant_type=authorization_code');
        return jsonResponse({
          access_token: 'youtube-access',
          refresh_token: 'youtube-refresh',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
          token_type: 'Bearer',
        });
      }
      if (url.pathname === '/youtube/v3/channels') {
        expect(url.searchParams.get('mine')).toBe('true');
        return jsonResponse({
          items: [
            {
              id: 'channel-1',
              snippet: {
                title: 'SocialHub Channel',
                customUrl: '@socialhub',
                thumbnails: { default: { url: 'https://cdn.test/avatar.jpg' } },
              },
              statistics: { subscriberCount: '12' },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    await expect(
      adapter.exchangeCodeForToken(
        'oauth-code',
        'http://localhost:4000/api/v1/oauth/youtube/callback',
      ),
    ).resolves.toMatchObject({
      accessToken: 'youtube-access',
      refreshToken: 'youtube-refresh',
      accountProfile: {
        externalAccountId: 'channel-1',
        name: 'SocialHub Channel',
        username: '@socialhub',
      },
    });
  });

  it('publish video lên YouTube bằng resumable upload', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/upload/youtube/v3/videos' && init?.method === 'POST') {
        expect(url.searchParams.get('uploadType')).toBe('resumable');
        expect(url.searchParams.get('part')).toBe('snippet,status');
        expect(init.headers).toMatchObject({
          authorization: 'Bearer youtube-access',
          'x-upload-content-length': '3',
          'x-upload-content-type': 'video/mp4',
        });
        expect(String(init.body)).toContain('"title":"Demo video"');
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.youtube.test/session-1' },
        });
      }
      if (url.href === 'https://upload.youtube.test/session-1') {
        expect(init?.method).toBe('PUT');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer youtube-access',
          'content-length': '3',
          'content-type': 'video/mp4',
        });
        expect(init?.body).toBeInstanceOf(Uint8Array);
        expect(init?.body).toEqual(new Uint8Array([1, 2, 3]));
        return jsonResponse(
          {
            id: 'video-1',
            status: { uploadStatus: 'uploaded', privacyStatus: 'public' },
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'youtube-access',
          externalAccountId: 'channel-1',
          correlationId: 'test',
        },
        {
          title: 'Demo video',
          description: 'Video description',
          hashtags: ['#demo'],
          media: [
            {
              type: 'VIDEO',
              url: 'workspaces/ws/media/video.mp4',
              bytes: new Uint8Array([1, 2, 3]),
              mimeType: 'video/mp4',
              sizeBytes: 3,
            },
          ],
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'video-1',
      externalUrl: 'https://www.youtube.com/watch?v=video-1',
    });
  });

  it('gửi custom thumbnail lên YouTube khi publish input có thumbnail', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/upload/youtube/v3/videos' && init?.method === 'POST') {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.youtube.test/session-thumb' },
        });
      }
      if (url.href === 'https://upload.youtube.test/session-thumb') {
        return jsonResponse(
          {
            id: 'video-thumb-1',
            status: { uploadStatus: 'uploaded', privacyStatus: 'public' },
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/upload/youtube/v3/thumbnails/set' && init?.method === 'POST') {
        expect(url.searchParams.get('videoId')).toBe('video-thumb-1');
        expect(url.searchParams.get('uploadType')).toBe('media');
        expect(init.headers).toMatchObject({
          authorization: 'Bearer youtube-access',
          'content-length': '4',
          'content-type': 'image/webp',
        });
        expect(init.body).toEqual(new Uint8Array([9, 8, 7, 6]));
        return jsonResponse({ items: [] });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    await expect(
      adapter.publishPost(
        {
          accessToken: 'youtube-access',
          externalAccountId: 'channel-1',
          correlationId: 'test',
        },
        {
          title: 'Demo video',
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
            url: 'workspaces/ws/media-thumbnails/video.webp',
            bytes: new Uint8Array([9, 8, 7, 6]),
            mimeType: 'image/webp',
            sizeBytes: 4,
          },
        },
      ),
    ).resolves.toMatchObject({
      externalPostId: 'video-thumb-1',
    });
  });

  it('chặn bài YouTube thiếu title hoặc không đúng 1 video', () => {
    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    expect(
      adapter.validatePost({
        title: '',
        media: [],
      }),
    ).toMatchObject({
      valid: false,
      issues: [
        expect.objectContaining({ field: 'media' }),
        expect.objectContaining({ field: 'title' }),
      ],
    });
  });

  it('lấy trạng thái xử lý và đổi video sang public', async () => {
    let statusReads = 0;
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/youtube/v3/videos' && init?.method !== 'PUT') {
        statusReads += 1;
        expect(url.searchParams.get('part')).toBe('processingDetails,status,snippet,statistics');
        expect(url.searchParams.get('id')).toBe('video-1');
        return jsonResponse({
          items: [
            {
              id: 'video-1',
              status: {
                uploadStatus: 'uploaded',
                privacyStatus: statusReads === 1 ? 'private' : 'public',
              },
              processingDetails: {
                processingStatus: 'succeeded',
                processingProgress: {
                  partsTotal: 10,
                  partsProcessed: 10,
                  timeLeftMs: 0,
                },
              },
            },
          ],
        });
      }
      if (url.pathname === '/youtube/v3/videos' && init?.method === 'PUT') {
        expect(url.searchParams.get('part')).toBe('status');
        expect(String(init.body)).toContain('"privacyStatus":"public"');
        return jsonResponse({
          id: 'video-1',
          status: { uploadStatus: 'uploaded', privacyStatus: 'public' },
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    await expect(
      adapter.getVideoPlatformState(
        {
          accessToken: 'youtube-access',
          externalAccountId: 'channel-1',
          correlationId: 'test',
        },
        'video-1',
      ),
    ).resolves.toMatchObject({
      videoId: 'video-1',
      privacyStatus: 'private',
      processingStatus: 'succeeded',
      processingProgress: { partsProcessed: 10, partsTotal: 10 },
    });

    await expect(
      adapter.makeVideoPublic(
        {
          accessToken: 'youtube-access',
          externalAccountId: 'channel-1',
          correlationId: 'test',
        },
        'video-1',
      ),
    ).resolves.toMatchObject({
      videoId: 'video-1',
      privacyStatus: 'public',
      processingStatus: 'succeeded',
    });
  });

  it('đọc metrics video YouTube từ statistics', async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/youtube/v3/videos') {
        expect(url.searchParams.get('part')).toBe('processingDetails,status,snippet,statistics');
        expect(url.searchParams.get('id')).toBe('video-1');
        return jsonResponse({
          items: [
            {
              id: 'video-1',
              statistics: {
                viewCount: '120',
                likeCount: '9',
                commentCount: '3',
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });

    await expect(
      adapter.getPostMetrics(
        {
          accessToken: 'youtube-access',
          externalAccountId: 'channel-1',
          correlationId: 'test',
        },
        'video-1',
      ),
    ).resolves.toMatchObject({
      views: { value: 120, source: 'PLATFORM_API' },
      likes: { value: 9, source: 'PLATFORM_API' },
      comments: { value: 3, source: 'PLATFORM_API' },
      engagement: { value: 12, source: 'PLATFORM_API' },
    });
  });

  it('đọc comments YouTube và reply comment', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/youtube/v3/commentThreads') {
        expect(url.searchParams.get('part')).toBe('snippet,replies');
        expect(url.searchParams.get('videoId')).toBe('video-1');
        expect(url.searchParams.get('textFormat')).toBe('plainText');
        return jsonResponse({
          nextPageToken: 'next-page',
          items: [
            {
              id: 'thread-1',
              snippet: {
                videoId: 'video-1',
                topLevelComment: {
                  id: 'comment-1',
                  snippet: {
                    authorDisplayName: 'Viewer One',
                    authorProfileImageUrl: 'https://cdn.test/viewer.jpg',
                    authorChannelId: { value: 'viewer-channel' },
                    textOriginal: 'Great video',
                    likeCount: 2,
                    publishedAt: '2026-07-28T01:00:00Z',
                  },
                },
              },
              replies: {
                comments: [
                  {
                    id: 'reply-1',
                    snippet: {
                      authorDisplayName: 'SocialHub Channel',
                      authorChannelId: { value: 'channel-1' },
                      parentId: 'comment-1',
                      textOriginal: 'Thanks!',
                      likeCount: 0,
                      publishedAt: '2026-07-28T01:01:00Z',
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.pathname === '/youtube/v3/comments') {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('"parentId":"comment-1"');
        expect(String(init?.body)).toContain('"textOriginal":"Reply from app"');
        return jsonResponse({
          id: 'reply-created',
          snippet: {
            parentId: 'comment-1',
            textOriginal: 'Reply from app',
            publishedAt: '2026-07-28T01:02:00Z',
          },
        });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new YouTubeAdapter({
      clientId: 'youtube-client',
      clientSecret: 'youtube-secret',
    });
    const ctx = {
      accessToken: 'youtube-access',
      externalAccountId: 'channel-1',
      correlationId: 'test',
    };

    await expect(adapter.getComments(ctx, { externalPostId: 'video-1' })).resolves.toMatchObject({
      hasMore: true,
      nextCursor: 'next-page',
      items: [
        {
          externalCommentId: 'comment-1',
          externalPostId: 'video-1',
          authorName: 'Viewer One',
          message: 'Great video',
          isFromOwner: false,
        },
        {
          externalCommentId: 'reply-1',
          parentExternalCommentId: 'comment-1',
          isFromOwner: true,
        },
      ],
    });

    await expect(adapter.replyToComment(ctx, 'comment-1', 'Reply from app')).resolves.toMatchObject(
      {
        externalReplyId: 'reply-created',
      },
    );
  });
});

describe('createRuntimeAdapterRegistry YouTube', () => {
  it('ưu tiên YouTube adapter thật khi cấu hình đủ credential', () => {
    const registry = createRuntimeAdapterRegistry({
      nodeEnv: 'development',
      youtube: {
        clientId: 'youtube-client',
        clientSecret: 'youtube-secret',
      },
    });

    expect(registry.get('YOUTUBE')).toBeInstanceOf(YouTubeAdapter);
    expect(registry.get('FACEBOOK')).toBeInstanceOf(DevelopmentFixtureAdapter);
  });
});
