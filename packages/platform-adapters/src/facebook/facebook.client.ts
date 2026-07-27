import type { z } from 'zod';
import {
  facebookNetworkError,
  facebookUnexpectedPayloadError,
  normalizeFacebookError,
} from './facebook.errors';
import {
  facebookPageProfileSchema,
  facebookPagesResponseSchema,
  facebookCommentReplyResponseSchema,
  facebookCommentsResponseSchema,
  facebookPhotoUploadResponseSchema,
  facebookPublishPostResponseSchema,
  facebookTokenResponseSchema,
  type FacebookCommentsResponse,
  type FacebookCommentReplyResponse,
  type FacebookPage,
  type FacebookPageProfile,
  type FacebookPhotoUploadResponse,
  type FacebookPublishPostResponse,
  type FacebookTokenResponse,
} from './facebook.schemas';

export interface FacebookGraphClientConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
  loginConfigId?: string;
}

export class FacebookGraphClient {
  private readonly graphBaseUrl: string;
  private readonly dialogBaseUrl: string;

  constructor(private readonly config: FacebookGraphClientConfig) {
    this.graphBaseUrl = `https://graph.facebook.com/${config.apiVersion}`;
    this.dialogBaseUrl = `https://www.facebook.com/${config.apiVersion}`;
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
    const form = new FormData();
    if (input.caption) form.set('caption', input.caption);
    form.set('published', input.published === false ? '0' : '1');
    if (input.temporary !== undefined) form.set('temporary', String(input.temporary));
    form.set('source', new File([input.bytes], input.fileName, { type: input.mimeType }));

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
  }): Promise<FacebookPublishPostResponse> {
    const form = new FormData();
    if (input.title) form.set('title', input.title);
    if (input.description) form.set('description', input.description);
    form.set('published', '1');
    form.set('source', new File([input.bytes], input.fileName, { type: input.mimeType }));

    return this.postMultipart(
      `/${input.pageId}/videos?access_token=${encodeURIComponent(input.pageAccessToken)}`,
      form,
      facebookPublishPostResponseSchema,
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
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
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
      response = await fetch(`${this.graphBaseUrl}${path}`, {
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

  private async postMultipart<T>(path: string, body: FormData, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.graphBaseUrl}${path}`, {
        method: 'POST',
        body,
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
