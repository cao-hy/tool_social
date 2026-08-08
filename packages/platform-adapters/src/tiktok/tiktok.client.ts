import { z } from 'zod';
import type { AdapterFetch } from '../core/types';
import { discardResponseBody } from '../core/utils';
import {
  normalizeTikTokError,
  tiktokApiEnvelopeError,
  tiktokNetworkError,
  tiktokUnexpectedPayloadError,
} from './tiktok.errors';
import {
  tiktokCancelPublishResponseSchema,
  tiktokCreatorInfoResponseSchema,
  tiktokPublishInitResponseSchema,
  tiktokPublishStatusResponseSchema,
  tiktokTokenResponseSchema,
  tiktokUserInfoResponseSchema,
  tiktokVideoListResponseSchema,
  tiktokVideoQueryResponseSchema,
  type TikTokCreatorInfoResponse,
  type TikTokPublishInitResponse,
  type TikTokPublishStatusResponse,
  type TikTokTokenResponse,
  type TikTokUserInfoResponse,
  type TikTokVideoListResponse,
  type TikTokVideoQueryResponse,
} from './tiktok.schemas';

export interface TikTokClientConfig {
  clientKey: string;
  clientSecret: string;
  fetch?: AdapterFetch;
}

export interface TikTokDirectVideoPostInput {
  accessToken: string;
  title?: string;
  bytes: Uint8Array;
  mimeType: string;
  privacyLevel: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  isAiGenerated?: boolean;
}

export interface TikTokInboxVideoUploadInput {
  accessToken: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface TikTokPhotoPostInput {
  accessToken: string;
  postMode: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  title?: string;
  description?: string;
  photoUrls: string[];
  photoCoverIndex?: number;
  privacyLevel?: string;
  disableComment?: boolean;
  autoAddMusic?: boolean;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  isAiGenerated?: boolean;
}

const API_BASE_URL = 'https://open.tiktokapis.com';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CHUNKS = 1000;

export class TikTokClient {
  private readonly fetch: AdapterFetch;

  constructor(private readonly config: TikTokClientConfig) {
    if (!config.fetch) {
      throw new Error('TikTokClient requires an explicit fetch implementation.');
    }
    this.fetch = config.fetch;
  }

  buildAuthorizationUrl(input: { redirectUri: string; state: string; scopes: string[] }): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_key', this.config.clientKey);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(','));
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  exchangeCodeForToken(code: string, redirectUri: string): Promise<TikTokTokenResponse> {
    return this.postForm(
      '/v2/oauth/token/',
      {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
      tiktokTokenResponseSchema,
    );
  }

  refreshToken(refreshToken: string): Promise<TikTokTokenResponse> {
    return this.postForm(
      '/v2/oauth/token/',
      {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      tiktokTokenResponseSchema,
    );
  }

  async revokeToken(token: string): Promise<void> {
    await this.postForm(
      '/v2/oauth/revoke/',
      {
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        token,
      },
      z.object({}).passthrough(),
    );
  }

  getUserInfo(accessToken: string): Promise<TikTokUserInfoResponse> {
    return this.get(
      '/v2/user/info/',
      {
        fields: 'open_id,union_id,avatar_url,avatar_url_100,avatar_large_url,display_name',
      },
      tiktokUserInfoResponseSchema,
      accessToken,
    );
  }

  queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfoResponse> {
    return this.postJson(
      '/v2/post/publish/creator_info/query/',
      {},
      tiktokCreatorInfoResponseSchema,
      accessToken,
    );
  }

  async directPostVideo(input: TikTokDirectVideoPostInput): Promise<TikTokPublishInitResponse> {
    const uploadPlan = createUploadPlan(input.bytes.byteLength);
    const init = await this.postJson(
      '/v2/post/publish/video/init/',
      {
        post_info: {
          title: input.title,
          privacy_level: input.privacyLevel,
          disable_comment: input.disableComment ?? false,
          disable_duet: input.disableDuet ?? false,
          disable_stitch: input.disableStitch ?? false,
          video_cover_timestamp_ms: input.videoCoverTimestampMs,
          brand_content_toggle: input.brandContentToggle,
          brand_organic_toggle: input.brandOrganicToggle,
          is_aigc: input.isAiGenerated,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: input.bytes.byteLength,
          chunk_size: uploadPlan.chunkSize,
          total_chunk_count: uploadPlan.totalChunkCount,
        },
      },
      tiktokPublishInitResponseSchema,
      input.accessToken,
    );

    if (!init.data.upload_url) {
      throw tiktokUnexpectedPayloadError(new Error('TikTok không trả upload_url.'), init);
    }

    await this.uploadChunks({
      uploadUrl: init.data.upload_url,
      bytes: input.bytes,
      mimeType: input.mimeType,
      uploadPlan,
    });

    return init;
  }

  async uploadVideoToInbox(input: TikTokInboxVideoUploadInput): Promise<TikTokPublishInitResponse> {
    const uploadPlan = createUploadPlan(input.bytes.byteLength);
    const init = await this.postJson(
      '/v2/post/publish/inbox/video/init/',
      {
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: input.bytes.byteLength,
          chunk_size: uploadPlan.chunkSize,
          total_chunk_count: uploadPlan.totalChunkCount,
        },
      },
      tiktokPublishInitResponseSchema,
      input.accessToken,
    );

    if (!init.data.upload_url) {
      throw tiktokUnexpectedPayloadError(new Error('TikTok không trả upload_url.'), init);
    }

    await this.uploadChunks({
      uploadUrl: init.data.upload_url,
      bytes: input.bytes,
      mimeType: input.mimeType,
      uploadPlan,
    });

    return init;
  }

  publishPhoto(input: TikTokPhotoPostInput): Promise<TikTokPublishInitResponse> {
    return this.postJson(
      '/v2/post/publish/content/init/',
      {
        media_type: 'PHOTO',
        post_mode: input.postMode,
        post_info: {
          title: input.title,
          description: input.description,
          privacy_level: input.postMode === 'DIRECT_POST' ? input.privacyLevel : undefined,
          disable_comment: input.postMode === 'DIRECT_POST' ? input.disableComment : undefined,
          auto_add_music: input.postMode === 'DIRECT_POST' ? input.autoAddMusic : undefined,
          brand_content_toggle:
            input.postMode === 'DIRECT_POST' ? input.brandContentToggle : undefined,
          brand_organic_toggle:
            input.postMode === 'DIRECT_POST' ? input.brandOrganicToggle : undefined,
          is_aigc: input.postMode === 'DIRECT_POST' ? input.isAiGenerated : undefined,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: input.photoCoverIndex ?? 0,
          photo_images: input.photoUrls,
        },
      },
      tiktokPublishInitResponseSchema,
      input.accessToken,
    );
  }

  async cancelPublish(accessToken: string, publishId: string): Promise<void> {
    await this.postJson(
      '/v2/post/publish/cancel/',
      { publish_id: publishId },
      tiktokCancelPublishResponseSchema,
      accessToken,
    );
  }

  fetchPublishStatus(accessToken: string, publishId: string): Promise<TikTokPublishStatusResponse> {
    return this.postJson(
      '/v2/post/publish/status/fetch/',
      { publish_id: publishId },
      tiktokPublishStatusResponseSchema,
      accessToken,
    );
  }

  listVideos(input: {
    accessToken: string;
    cursor?: number;
    limit?: number;
  }): Promise<TikTokVideoListResponse> {
    return this.postJson(
      '/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time,duration,height,width,like_count,comment_count,share_count,view_count',
      {
        cursor: input.cursor,
        max_count: input.limit,
      },
      tiktokVideoListResponseSchema,
      input.accessToken,
    );
  }

  queryVideos(accessToken: string, videoIds: string[]): Promise<TikTokVideoQueryResponse> {
    return this.postJson(
      '/v2/video/query/?fields=id,title,video_description,cover_image_url,share_url,create_time,duration,height,width,like_count,comment_count,share_count,view_count',
      {
        filters: {
          video_ids: videoIds,
        },
      },
      tiktokVideoQueryResponseSchema,
      accessToken,
    );
  }

  private async uploadChunks(input: {
    uploadUrl: string;
    bytes: Uint8Array;
    mimeType: string;
    uploadPlan: UploadPlan;
  }): Promise<void> {
    const total = input.bytes.byteLength;
    for (let index = 0; index < input.uploadPlan.totalChunkCount; index += 1) {
      const firstByte = index * input.uploadPlan.chunkSize;
      const lastByte =
        index === input.uploadPlan.totalChunkCount - 1
          ? total - 1
          : firstByte + input.uploadPlan.chunkSize - 1;
      const chunk = input.bytes.slice(firstByte, lastByte + 1);

      let response: Response;
      try {
        response = await this.fetch(input.uploadUrl, {
          method: 'PUT',
          headers: {
            'content-type': input.mimeType,
            'content-length': String(chunk.byteLength),
            'content-range': `bytes ${firstByte}-${lastByte}/${total}`,
          },
          body: chunk,
          signal: AbortSignal.timeout(600000),
        });
      } catch (error) {
        throw tiktokNetworkError(error);
      }

      if (![200, 201, 206].includes(response.status)) {
        throw normalizeTikTokError({
          status: response.status,
          payload: await parseJson(response),
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        });
      }

      await discardResponseBody(response);
    }
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    const url = new URL(`${API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw tiktokNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async postForm<T>(
    path: string,
    body: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw tiktokNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(stripUndefinedDeep(body)),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw tiktokNetworkError(error);
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
    throw normalizeTikTokError({
      status: response.status,
      payload,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw tiktokUnexpectedPayloadError(parsed.error, payload);
  const envelope = payload as { error?: { code?: string; message?: string } };
  if (envelope.error?.code && envelope.error.code !== 'ok') {
    throw tiktokApiEnvelopeError({
      code: envelope.error.code,
      message: envelope.error.message,
      raw: payload,
    });
  }
  return parsed.data;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: text };
  }
}

interface UploadPlan {
  chunkSize: number;
  totalChunkCount: number;
}

function createUploadPlan(videoSize: number): UploadPlan {
  if (videoSize <= 0) throw new Error('TikTok video rỗng.');
  if (videoSize <= MAX_CHUNK_SIZE) return { chunkSize: videoSize, totalChunkCount: 1 };

  const totalChunkCount = Math.ceil(videoSize / MAX_CHUNK_SIZE);
  if (totalChunkCount > MAX_CHUNKS) {
    throw new Error('TikTok video quá lớn: vượt quá 1000 chunks upload.');
  }
  const chunkSize = Math.floor(videoSize / totalChunkCount);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error('TikTok video không thể chia chunk hợp lệ.');
  }
  return { chunkSize, totalChunkCount };
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
