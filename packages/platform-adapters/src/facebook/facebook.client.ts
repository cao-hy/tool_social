import type { z } from 'zod';
import type { AdapterFetch } from '../core/types';
import {
  facebookNetworkError,
  facebookUnexpectedPayloadError,
  normalizeFacebookError,
} from './facebook.errors';
import {
  facebookPageProfileSchema,
  facebookPostEngagementSchema,
  facebookPagesResponseSchema,
  facebookCommentReplyResponseSchema,
  facebookCommentsResponseSchema,
  facebookInsightsResponseSchema,
  facebookMutationResponseSchema,
  facebookPhotoUploadResponseSchema,
  facebookPublishPostResponseSchema,
  facebookTokenResponseSchema,
  facebookPagePostsResponseSchema,
  type FacebookCommentsResponse,
  type FacebookCommentReplyResponse,
  type FacebookPostEngagement,
  type FacebookInsightsResponse,
  type FacebookPage,
  type FacebookPageProfile,
  type FacebookMutationResponse,
  type FacebookPhotoUploadResponse,
  type FacebookPublishPostResponse,
  type FacebookTokenResponse,
  type FacebookPagePostsResponse,
} from './facebook.schemas';

export interface FacebookGraphClientConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
  loginConfigId?: string;
  fetch?: AdapterFetch;
}

export class FacebookGraphClient {
  private readonly graphBaseUrl: string;
  private readonly videoBaseUrl: string;
  private readonly dialogBaseUrl: string;
  private readonly fetch: AdapterFetch;

  constructor(private readonly config: FacebookGraphClientConfig) {
    this.graphBaseUrl = `https://graph.facebook.com/${config.apiVersion}`;
    this.videoBaseUrl = `https://graph-video.facebook.com/${config.apiVersion}`;
    this.dialogBaseUrl = `https://www.facebook.com/${config.apiVersion}`;
    this.fetch = config.fetch ?? fetch;
  }

  buildAuthorizationUrl(input: { redirectUri: string; state: string; scopes: string[] }): string {
    const url = new URL(`${this.dialogBaseUrl}/dialog/oauth`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('return_scopes', 'true');
    if (this.config.loginConfigId) {
      url.searchParams.set('config_id', this.config.loginConfigId);
      url.searchParams.set('override_default_response_type', 'true');
    } else {
      url.searchParams.set('scope', input.scopes.join(','));
    }
    return url.toString();
  }

  async exchangeCodeForUserToken(
    code: string,
    redirectUri: string,
  ): Promise<FacebookTokenResponse> {
    return this.get(
      '/oauth/access_token',
      {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        redirect_uri: redirectUri,
        code,
      },
      facebookTokenResponseSchema,
    );
  }

  async extendUserToken(userAccessToken: string): Promise<FacebookTokenResponse> {
    return this.get(
      '/oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: userAccessToken,
      },
      facebookTokenResponseSchema,
    );
  }

  async getManagedPages(userAccessToken: string): Promise<FacebookPage[]> {
    const response = await this.get(
      '/me/accounts',
      {
        fields: 'id,name,access_token,tasks,username,link,picture{url}',
        access_token: userAccessToken,
      },
      facebookPagesResponseSchema,
    );
    return response.data;
  }

  async getPageProfile(pageAccessToken: string): Promise<FacebookPageProfile> {
    return this.get(
      '/me',
      {
        fields: 'id,name,username,link,fan_count,picture{url}',
        access_token: pageAccessToken,
      },
      facebookPageProfileSchema,
    );
  }

  async getPagePosts(input: {
    pageId: string;
    pageAccessToken: string;
    cursor?: string;
    limit?: number;
    since?: Date;
  }): Promise<FacebookPagePostsResponse> {
    const params: Record<string, string> = {
      access_token: input.pageAccessToken,
      fields:
        'id,message,created_time,updated_time,permalink_url,attachments{title,description,type,url,media,subattachments},shares,likes.summary(true),comments.summary(true)',
      limit: String(input.limit ?? 50),
    };
    if (input.cursor) params.after = input.cursor;
    if (input.since) params.since = String(Math.floor(input.since.getTime() / 1000));

    return this.get(`/${input.pageId}/published_posts`, params, facebookPagePostsResponseSchema);
  }

  async publishPageFeedPost(input: {
    pageId: string;
    pageAccessToken: string;
    message?: string;
    link?: string;
    attachedMediaIds?: string[];
  }): Promise<FacebookPublishPostResponse> {
    const body: Record<string, string> = {
      access_token: input.pageAccessToken,
      published: '1',
    };
    if (input.message) body.message = input.message;
    if (input.link) body.link = input.link;
    input.attachedMediaIds?.forEach((mediaId, index) => {
      body[`attached_media[${index}]`] = JSON.stringify({ media_fbid: mediaId });
    });

    return this.postForm(`/${input.pageId}/feed`, body, facebookPublishPostResponseSchema);
  }

  async uploadPagePhoto(input: {
    pageId: string;
    pageAccessToken: string;
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    caption?: string;
    published?: boolean;
    temporary?: boolean;
  }): Promise<FacebookPhotoUploadResponse> {
    const form = encodeMultipartForm([
      ...(input.caption ? [{ name: 'caption', value: input.caption }] : []),
      { name: 'published', value: input.published === false ? '0' : '1' },
      ...(input.temporary !== undefined
        ? [{ name: 'temporary', value: String(input.temporary) }]
        : []),
      {
        name: 'source',
        fileName: input.fileName,
        mimeType: input.mimeType,
        bytes: input.bytes,
      },
    ]);

    return this.postMultipart(
      `/${input.pageId}/photos?access_token=${encodeURIComponent(input.pageAccessToken)}`,
      form,
      facebookPhotoUploadResponseSchema,
    );
  }

  async publishPageVideo(input: {
    pageId: string;
    pageAccessToken: string;
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    title?: string;
    description?: string;
    thumbnail?: {
      bytes: Uint8Array;
      fileName: string;
      mimeType: string;
    };
  }): Promise<FacebookPublishPostResponse> {
    const form = encodeMultipartForm([
      ...(input.title ? [{ name: 'title', value: input.title }] : []),
      ...(input.description ? [{ name: 'description', value: input.description }] : []),
      { name: 'published', value: '1' },
      ...(input.thumbnail
        ? [
            {
              name: 'thumb',
              fileName: input.thumbnail.fileName,
              mimeType: input.thumbnail.mimeType,
              bytes: input.thumbnail.bytes,
            },
          ]
        : []),
      {
        name: 'source',
        fileName: input.fileName,
        mimeType: input.mimeType,
        bytes: input.bytes,
      },
    ]);

    return this.postMultipart(
      `/${input.pageId}/videos?access_token=${encodeURIComponent(input.pageAccessToken)}`,
      form,
      facebookPublishPostResponseSchema,
      this.videoBaseUrl,
    );
  }

  async setVideoThumbnail(input: {
    videoId: string;
    pageAccessToken: string;
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  }): Promise<FacebookMutationResponse> {
    const form = encodeMultipartForm([
      {
        name: 'source',
        fileName: input.fileName,
        mimeType: input.mimeType,
        bytes: input.bytes,
      },
      { name: 'is_preferred', value: 'true' },
    ]);

    return this.postMultipart(
      `/${input.videoId}/thumbnails?access_token=${encodeURIComponent(input.pageAccessToken)}`,
      form,
      facebookMutationResponseSchema,
    );
  }

  async getPostComments(input: {
    externalPostId: string;
    pageAccessToken: string;
    cursor?: string;
    limit?: number;
    since?: Date;
  }): Promise<FacebookCommentsResponse> {
    const params: Record<string, string> = {
      access_token: input.pageAccessToken,
      fields: 'id,message,from{id,name,picture},created_time,like_count,parent{id},is_hidden',
      filter: 'stream',
      limit: String(input.limit ?? 25),
      order: 'chronological',
    };
    if (input.cursor) params.after = input.cursor;
    if (input.since) params.since = String(Math.floor(input.since.getTime() / 1000));

    return this.get(`/${input.externalPostId}/comments`, params, facebookCommentsResponseSchema);
  }

  async replyToComment(input: {
    externalCommentId: string;
    pageAccessToken: string;
    message: string;
  }): Promise<FacebookCommentReplyResponse> {
    return this.postForm(
      `/${input.externalCommentId}/comments`,
      {
        access_token: input.pageAccessToken,
        message: input.message,
      },
      facebookCommentReplyResponseSchema,
    );
  }

  async hideComment(input: {
    externalCommentId: string;
    pageAccessToken: string;
    hidden: boolean;
  }): Promise<FacebookMutationResponse> {
    return this.postForm(
      `/${input.externalCommentId}`,
      {
        access_token: input.pageAccessToken,
        is_hidden: input.hidden ? 'true' : 'false',
      },
      facebookMutationResponseSchema,
    );
  }

  async deleteComment(input: {
    externalCommentId: string;
    pageAccessToken: string;
  }): Promise<FacebookMutationResponse> {
    return this.delete(
      `/${input.externalCommentId}`,
      { access_token: input.pageAccessToken },
      facebookMutationResponseSchema,
    );
  }

  async updatePagePost(input: {
    externalPostId: string;
    pageAccessToken: string;
    message?: string;
    link?: string;
  }): Promise<FacebookMutationResponse> {
    const body: Record<string, string> = { access_token: input.pageAccessToken };
    if (input.message !== undefined) body.message = input.message;
    if (input.link !== undefined) body.link = input.link;

    return this.postForm(`/${input.externalPostId}`, body, facebookMutationResponseSchema);
  }

  async updatePageVideo(input: {
    externalPostId: string;
    pageAccessToken: string;
    title?: string;
    description?: string;
  }): Promise<FacebookMutationResponse> {
    const body: Record<string, string> = { access_token: input.pageAccessToken };
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;

    return this.postForm(`/${input.externalPostId}`, body, facebookMutationResponseSchema);
  }

  async deletePagePost(input: {
    externalPostId: string;
    pageAccessToken: string;
  }): Promise<FacebookMutationResponse> {
    return this.delete(
      `/${input.externalPostId}`,
      { access_token: input.pageAccessToken },
      facebookMutationResponseSchema,
    );
  }

  async getPostEngagement(input: {
    externalPostId: string;
    pageAccessToken: string;
  }): Promise<FacebookPostEngagement> {
    return this.get(
      `/${input.externalPostId}`,
      {
        access_token: input.pageAccessToken,
        fields: 'reactions.limit(0).summary(true),comments.limit(0).summary(true),shares',
      },
      facebookPostEngagementSchema,
    );
  }

  async getPostInsights(input: {
    externalPostId: string;
    pageAccessToken: string;
    metrics: string[];
  }): Promise<FacebookInsightsResponse> {
    return this.get(
      `/${input.externalPostId}/insights`,
      {
        access_token: input.pageAccessToken,
        metric: input.metrics.join(','),
        period: 'lifetime',
      },
      facebookInsightsResponseSchema,
    );
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${this.graphBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      throw facebookNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeFacebookError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw facebookUnexpectedPayloadError(parsed.error, payload);
    return parsed.data;
  }

  private async postForm<T>(
    path: string,
    body: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.graphBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw facebookNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeFacebookError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw facebookUnexpectedPayloadError(parsed.error, payload);
    return parsed.data;
  }

  private async postMultipart<T>(
    path: string,
    body: EncodedMultipartForm,
    schema: z.ZodType<T>,
    baseUrl = this.graphBaseUrl,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': body.contentType,
          'content-length': String(body.body.byteLength),
        },
        body: body.body,
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
      throw facebookNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeFacebookError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw facebookUnexpectedPayloadError(parsed.error, payload);
    return parsed.data;
  }

  private async delete<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${this.graphBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw facebookNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeFacebookError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw facebookUnexpectedPayloadError(parsed.error, payload);
    return parsed.data;
  }
}

interface EncodedMultipartForm {
  contentType: string;
  body: Uint8Array;
}

type MultipartPart =
  | {
      name: string;
      value: string;
    }
  | {
      name: string;
      fileName: string;
      mimeType: string;
      bytes: Uint8Array;
    };

function encodeMultipartForm(parts: MultipartPart[]): EncodedMultipartForm {
  const boundary = `socialhub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    if ('bytes' in part) {
      chunks.push(
        encoder.encode(
          `Content-Disposition: form-data; name="${escapeMultipartValue(part.name)}"; filename="${escapeMultipartValue(part.fileName)}"\r\n` +
            `Content-Type: ${sanitizeHeaderValue(part.mimeType)}\r\n\r\n`,
        ),
      );
      chunks.push(part.bytes);
      chunks.push(encoder.encode('\r\n'));
    } else {
      chunks.push(
        encoder.encode(
          `Content-Disposition: form-data; name="${escapeMultipartValue(part.name)}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: concatUint8Arrays(chunks),
  };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function escapeMultipartValue(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '').trim() || 'application/octet-stream';
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw facebookUnexpectedPayloadError(error, { status: response.status, body: text });
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
