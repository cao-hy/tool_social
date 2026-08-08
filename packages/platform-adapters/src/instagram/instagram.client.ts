import type { z } from 'zod';
import type { AdapterFetch } from '../core/types';
import {
  instagramNetworkError,
  instagramUnexpectedPayloadError,
  normalizeInstagramError,
} from './instagram.errors';
import {
  instagramProfileSchema,
  instagramPagesResponseSchema,
  instagramTokenResponseSchema,
  instagramMediaContainerResponseSchema,
  instagramContainerStatusSchema,
  instagramMediaPageSchema,
  instagramMediaSchema,
  instagramPublishResponseSchema,
  instagramSuccessResponseSchema,
  instagramCommentsPageSchema,
  instagramInsightsResponseSchema,
  type InstagramPage,
  type InstagramProfile,
  type InstagramTokenResponse,
  type InstagramMedia,
  type InstagramContainerStatus,
  type InstagramMediaPage,
  type InstagramCommentsPage,
  type InstagramInsightsResponse,
  instagramLocationSearchResponseSchema,
  type InstagramLocation,
} from './instagram.schemas';

export interface InstagramGraphClientConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
  fetch?: AdapterFetch;
}

export class InstagramGraphClient {
  private readonly graphBaseUrl: string;
  private readonly dialogBaseUrl: string;
  private readonly fetch: AdapterFetch;

  constructor(private readonly config: InstagramGraphClientConfig) {
    if (!config.fetch) {
      throw new Error('InstagramGraphClient requires an explicit fetch implementation.');
    }
    this.graphBaseUrl = `https://graph.facebook.com/${config.apiVersion}`;
    this.dialogBaseUrl = `https://www.facebook.com/${config.apiVersion}`;
    this.fetch = config.fetch;
  }

  buildAuthorizationUrl(input: { redirectUri: string; state: string; scopes: string[] }): string {
    const url = new URL(`${this.dialogBaseUrl}/dialog/oauth`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(','));
    return url.toString();
  }

  async exchangeCodeForUserToken(
    code: string,
    redirectUri: string,
  ): Promise<InstagramTokenResponse> {
    return this.get(
      '/oauth/access_token',
      {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        redirect_uri: redirectUri,
        code,
      },
      instagramTokenResponseSchema,
    );
  }

  async extendUserToken(userAccessToken: string): Promise<InstagramTokenResponse> {
    return this.get(
      '/oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: userAccessToken,
      },
      instagramTokenResponseSchema,
    );
  }

  async getManagedPages(userAccessToken: string): Promise<InstagramPage[]> {
    const response = await this.get(
      '/me/accounts',
      {
        fields: 'id,name,access_token,instagram_business_account{id}',
        access_token: userAccessToken,
      },
      instagramPagesResponseSchema,
    );
    return response.data;
  }

  async getInstagramProfile(
    igAccountId: string,
    userAccessToken: string,
  ): Promise<InstagramProfile> {
    return this.get(
      `/${igAccountId}`,
      {
        fields: 'id,username,name,profile_picture_url,followers_count',
        access_token: userAccessToken,
      },
      instagramProfileSchema,
    );
  }

  async searchLocations(query: string, userAccessToken: string): Promise<InstagramLocation[]> {
    const response = await this.get(
      '/pages/search',
      {
        q: query,
        fields: 'id,name,location',
        access_token: userAccessToken,
      },
      instagramLocationSearchResponseSchema,
    );
    return response.data;
  }

  async createMediaContainer(input: {
    igAccountId: string;
    accessToken: string;
    imageUrl?: string;
    videoUrl?: string;
    caption?: string;
    isCarouselItem?: boolean;
    mediaType?: 'IMAGE' | 'VIDEO' | 'CAROUSEL' | 'REELS' | 'STORIES';
    children?: string[];
    shareToFeed?: boolean;
    coverUrl?: string;
    locationId?: string;
    altText?: string;
    collaborators?: string[];
    userTags?: unknown[];
  }): Promise<string> {
    const body: Record<string, string> = {
      access_token: input.accessToken,
    };

    if (input.imageUrl) body.image_url = input.imageUrl;
    if (input.videoUrl) {
      body.video_url = input.videoUrl;
      body.media_type = 'VIDEO';
    }
    if (input.caption) body.caption = input.caption;
    if (input.coverUrl) body.cover_url = input.coverUrl;
    if (input.locationId) body.location_id = input.locationId;
    if (input.altText) body.alt_text = input.altText;
    if (input.collaborators?.length) body.collaborators = input.collaborators.join(',');
    if (input.userTags?.length) body.user_tags = JSON.stringify(input.userTags);
    if (input.isCarouselItem) body.is_carousel_item = 'true';
    if (input.mediaType === 'REELS' || input.mediaType === 'STORIES') {
      body.media_type = input.mediaType;
    }
    if (input.shareToFeed !== undefined) {
      body.share_to_feed = input.shareToFeed ? 'true' : 'false';
    }
    if (input.mediaType === 'CAROUSEL' && input.children) {
      body.media_type = 'CAROUSEL';
      body.children = input.children.join(',');
    }

    const response = await this.postForm(
      `/${input.igAccountId}/media`,
      body,
      instagramMediaContainerResponseSchema,
    );
    return response.id;
  }

  async getContainerStatus(input: {
    containerId: string;
    accessToken: string;
  }): Promise<InstagramContainerStatus> {
    return this.get(
      `/${input.containerId}`,
      {
        fields: 'status_code,status',
        access_token: input.accessToken,
      },
      instagramContainerStatusSchema,
    );
  }

  async publishMedia(input: {
    igAccountId: string;
    accessToken: string;
    creationId: string;
  }): Promise<string> {
    const response = await this.postForm(
      `/${input.igAccountId}/media_publish`,
      {
        access_token: input.accessToken,
        creation_id: input.creationId,
      },
      instagramPublishResponseSchema,
    );
    return response.id;
  }

  async getUserMedia(input: {
    igAccountId: string;
    accessToken: string;
    cursor?: string;
    limit?: number;
    since?: Date;
  }): Promise<InstagramMediaPage> {
    return this.get(
      `/${input.igAccountId}/media`,
      {
        fields:
          'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count',
        access_token: input.accessToken,
        ...(input.cursor ? { after: input.cursor } : {}),
        ...(input.limit ? { limit: String(input.limit) } : {}),
        ...(input.since ? { since: String(Math.floor(input.since.getTime() / 1000)) } : {}),
      },
      instagramMediaPageSchema,
    );
  }

  async getMedia(input: { mediaId: string; accessToken: string }): Promise<InstagramMedia> {
    return this.get(
      `/${input.mediaId}`,
      {
        fields:
          'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count',
        access_token: input.accessToken,
      },
      instagramMediaSchema,
    );
  }

  async getMediaInsights(input: {
    mediaId: string;
    accessToken: string;
    metrics: string[];
  }): Promise<InstagramInsightsResponse> {
    return this.get(
      `/${input.mediaId}/insights`,
      {
        metric: input.metrics.join(','),
        access_token: input.accessToken,
      },
      instagramInsightsResponseSchema,
    );
  }

  async getUserInsights(input: {
    igAccountId: string;
    accessToken: string;
    metrics: string[];
    period?: 'day' | 'week' | 'days_28' | 'lifetime';
  }): Promise<InstagramInsightsResponse> {
    return this.get(
      `/${input.igAccountId}/insights`,
      {
        metric: input.metrics.join(','),
        period: input.period ?? 'day',
        access_token: input.accessToken,
      },
      instagramInsightsResponseSchema,
    );
  }

  async getMediaComments(input: {
    mediaId: string;
    accessToken: string;
    cursor?: string;
    limit?: number;
  }): Promise<InstagramCommentsPage> {
    return this.get(
      `/${input.mediaId}/comments`,
      {
        fields: 'id,text,timestamp,username,like_count,hidden',
        access_token: input.accessToken,
        ...(input.cursor ? { after: input.cursor } : {}),
        ...(input.limit ? { limit: String(input.limit) } : {}),
      },
      instagramCommentsPageSchema,
    );
  }

  async replyToComment(input: {
    commentId: string;
    accessToken: string;
    message: string;
  }): Promise<string> {
    const response = await this.postForm(
      `/${input.commentId}/replies`,
      {
        access_token: input.accessToken,
        message: input.message,
      },
      instagramMediaContainerResponseSchema,
    );
    return response.id;
  }

  async createMediaComment(input: {
    mediaId: string;
    accessToken: string;
    message: string;
  }): Promise<string> {
    const response = await this.postForm(
      `/${input.mediaId}/comments`,
      {
        access_token: input.accessToken,
        message: input.message,
      },
      instagramMediaContainerResponseSchema,
    );
    return response.id;
  }

  async hideComment(input: {
    commentId: string;
    accessToken: string;
    hidden: boolean;
  }): Promise<void> {
    await this.postForm(
      `/${input.commentId}`,
      {
        access_token: input.accessToken,
        hide: input.hidden ? 'true' : 'false',
      },
      instagramSuccessResponseSchema,
    );
  }

  async deleteComment(input: { commentId: string; accessToken: string }): Promise<void> {
    await this.delete(
      `/${input.commentId}`,
      {
        access_token: input.accessToken,
      },
      instagramSuccessResponseSchema,
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
      throw instagramNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeInstagramError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw instagramUnexpectedPayloadError(parsed.error, payload);
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
      throw instagramNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeInstagramError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw instagramUnexpectedPayloadError(parsed.error, payload);
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
      throw instagramNetworkError(error);
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      throw normalizeInstagramError({
        status: response.status,
        payload,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw instagramUnexpectedPayloadError(parsed.error, payload);
    return parsed.data;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw instagramUnexpectedPayloadError(error, { status: response.status, body: text });
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
