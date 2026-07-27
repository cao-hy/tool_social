import type { z } from 'zod';
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
  instagramPublishResponseSchema,
  type InstagramPage,
  type InstagramProfile,
  type InstagramTokenResponse,
} from './instagram.schemas';

export interface InstagramGraphClientConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
}

export class InstagramGraphClient {
  private readonly graphBaseUrl: string;
  private readonly dialogBaseUrl: string;

  constructor(private readonly config: InstagramGraphClientConfig) {
    this.graphBaseUrl = `https://graph.facebook.com/${config.apiVersion}`;
    this.dialogBaseUrl = `https://www.facebook.com/${config.apiVersion}`;
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

  async createMediaContainer(input: {
    igAccountId: string;
    accessToken: string;
    imageUrl?: string;
    videoUrl?: string;
    caption?: string;
    isCarouselItem?: boolean;
    mediaType?: 'IMAGE' | 'VIDEO' | 'CAROUSEL';
    children?: string[];
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
    if (input.isCarouselItem) body.is_carousel_item = 'true';
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
      response = await fetch(`${this.graphBaseUrl}${path}`, {
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
