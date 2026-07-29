import type { z } from 'zod';
import {
  normalizeYouTubeError,
  youtubeNetworkError,
  youtubeUnexpectedPayloadError,
} from './youtube.errors';
import {
  youtubeChannelsResponseSchema,
  youtubeCommentThreadsResponseSchema,
  youtubeCommentSchema,
  youtubeTokenResponseSchema,
  youtubeVideoResponseSchema,
  youtubeVideosResponseSchema,
  type YouTubeChannel,
  type YouTubeComment,
  type YouTubeCommentThreadsResponse,
  type YouTubeTokenResponse,
  type YouTubeVideoResponse,
} from './youtube.schemas';

export interface YouTubeClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface YouTubeUploadVideoInput {
  accessToken: string;
  title: string;
  description?: string;
  tags?: string[];
  bytes: Uint8Array;
  mimeType: string;
  privacyStatus?: 'public' | 'private' | 'unlisted';
  categoryId?: string;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
}

export class YouTubeClient {
  private readonly authBaseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  private readonly tokenUrl = 'https://oauth2.googleapis.com/token';
  private readonly revokeUrl = 'https://oauth2.googleapis.com/revoke';
  private readonly apiBaseUrl = 'https://www.googleapis.com/youtube/v3';
  private readonly uploadBaseUrl = 'https://www.googleapis.com/upload/youtube/v3';

  constructor(private readonly config: YouTubeClientConfig) {}

  buildAuthorizationUrl(input: { redirectUri: string; state: string; scopes: string[] }): string {
    const url = new URL(this.authBaseUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  exchangeCodeForToken(code: string, redirectUri: string): Promise<YouTubeTokenResponse> {
    return this.postForm(
      this.tokenUrl,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      },
      youtubeTokenResponseSchema,
    );
  }

  refreshToken(refreshToken: string): Promise<YouTubeTokenResponse> {
    return this.postForm(
      this.tokenUrl,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      },
      youtubeTokenResponseSchema,
    );
  }

  async revokeToken(token: string): Promise<void> {
    const url = new URL(this.revokeUrl);
    url.searchParams.set('token', token);

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000) });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    if (!response.ok) {
      throw normalizeYouTubeError({
        status: response.status,
        payload: await parseJson(response),
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }
  }

  async getMyChannel(accessToken: string): Promise<YouTubeChannel> {
    const response = await this.get(
      '/channels',
      {
        part: 'snippet,statistics',
        mine: 'true',
      },
      youtubeChannelsResponseSchema,
      accessToken,
    );
    const channel = response.items[0];
    if (!channel) {
      throw normalizeYouTubeError({
        status: 404,
        payload: {
          error: {
            code: 404,
            message:
              'Google account này chưa có YouTube channel. Hãy tạo channel trước khi kết nối.',
            errors: [{ reason: 'channelNotFound' }],
          },
        },
      });
    }
    return channel;
  }

  async uploadVideo(input: YouTubeUploadVideoInput): Promise<YouTubeVideoResponse> {
    const metadata = {
      snippet: {
        title: input.title,
        description: input.description,
        tags: input.tags,
        categoryId: input.categoryId ?? '22',
      },
      status: {
        privacyStatus: input.privacyStatus ?? 'public',
        selfDeclaredMadeForKids: input.selfDeclaredMadeForKids ?? false,
        containsSyntheticMedia: input.containsSyntheticMedia,
      },
    };

    const sessionUrl = await this.startResumableUpload({
      accessToken: input.accessToken,
      bytesLength: input.bytes.byteLength,
      mimeType: input.mimeType,
      metadata,
    });

    return this.putUploadBytes({
      accessToken: input.accessToken,
      sessionUrl,
      bytes: input.bytes,
      mimeType: input.mimeType,
    });
  }

  async getVideoStatus(accessToken: string, videoId: string): Promise<YouTubeVideoResponse> {
    const response = await this.get(
      '/videos',
      {
        part: 'processingDetails,status,snippet',
        id: videoId,
      },
      youtubeVideosResponseSchema,
      accessToken,
    );
    const video = response.items[0];
    if (!video) {
      throw normalizeYouTubeError({
        status: 404,
        payload: {
          error: {
            code: 404,
            message: 'Không tìm thấy video YouTube.',
            errors: [{ reason: 'videoNotFound' }],
          },
        },
      });
    }
    return video;
  }

  updateVideoPrivacy(input: {
    accessToken: string;
    videoId: string;
    privacyStatus: 'public' | 'private' | 'unlisted';
  }): Promise<YouTubeVideoResponse> {
    return this.putJson(
      '/videos',
      {
        id: input.videoId,
        status: {
          privacyStatus: input.privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      { part: 'status' },
      youtubeVideoResponseSchema,
      input.accessToken,
    );
  }

  getVideoComments(input: {
    accessToken: string;
    videoId: string;
    cursor?: string;
    limit?: number;
  }): Promise<YouTubeCommentThreadsResponse> {
    return this.get(
      '/commentThreads',
      {
        part: 'snippet,replies',
        videoId: input.videoId,
        order: 'time',
        textFormat: 'plainText',
        maxResults: String(Math.min(Math.max(input.limit ?? 50, 1), 100)),
        ...(input.cursor ? { pageToken: input.cursor } : {}),
      },
      youtubeCommentThreadsResponseSchema,
      input.accessToken,
    );
  }

  replyToComment(input: {
    accessToken: string;
    parentCommentId: string;
    message: string;
  }): Promise<YouTubeComment> {
    return this.postJson(
      '/comments',
      {
        snippet: {
          parentId: input.parentCommentId,
          textOriginal: input.message,
        },
      },
      { part: 'snippet' },
      youtubeCommentSchema,
      input.accessToken,
    );
  }

  private async startResumableUpload(input: {
    accessToken: string;
    bytesLength: number;
    mimeType: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const url = new URL(`${this.uploadBaseUrl}/videos`);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('part', 'snippet,status');
    const body = JSON.stringify(stripUndefinedDeep(input.metadata));

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(input.bytesLength),
          'x-upload-content-type': input.mimeType,
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    if (!response.ok) {
      throw normalizeYouTubeError({
        status: response.status,
        payload: await parseJson(response),
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const location = response.headers.get('location');
    if (!location) {
      throw youtubeUnexpectedPayloadError(
        new Error('Thiếu Location header khi tạo resumable upload session.'),
        { status: response.status },
      );
    }
    return location;
  }

  private async putUploadBytes(input: {
    accessToken: string;
    sessionUrl: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<YouTubeVideoResponse> {
    let response: Response;
    try {
      response = await fetch(input.sessionUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'content-length': String(input.bytes.byteLength),
          'content-type': input.mimeType,
        },
        body: new Blob([input.bytes], { type: input.mimeType }),
        signal: AbortSignal.timeout(600000),
      });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    return parseResponse(response, youtubeVideoResponseSchema);
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async postForm<T>(
    url: string,
    body: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async putJson<T>(
    path: string,
    body: Record<string, unknown>,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(stripUndefinedDeep(body)),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(stripUndefinedDeep(body)),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw youtubeNetworkError(error);
    }

    return parseResponse(response, schema);
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const payload = await parseJson(response);
  if (!response.ok) {
    throw normalizeYouTubeError({
      status: response.status,
      payload,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw youtubeUnexpectedPayloadError(parsed.error, payload);
  return parsed.data;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw youtubeUnexpectedPayloadError(error, { status: response.status, body: text });
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(0, date.getTime() - Date.now());
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedDeep(entry)]),
  );
}
