import type { Paginated } from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import { capabilityUnsupported } from '../core/platform-error';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  PlatformPostData,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  PostMetrics,
  SyncCommentsParams,
  TokenSet,
} from '../core/types';
import { FacebookGraphClient, type FacebookGraphClientConfig } from './facebook.client';
import {
  mapFacebookComment,
  mapFacebookPageProfile,
  mapFacebookPageToken,
  selectFacebookPage,
} from './facebook.mapper';
import { validateFacebookPost } from './facebook.validator';
import { parseMetaWebhookEvents, verifyMetaWebhookSignature } from '../meta/webhook';

export interface FacebookPagesAdapterConfig extends FacebookGraphClientConfig {
  scopes?: string[];
}

export const FACEBOOK_PAGES_OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'pages_manage_engagement',
] as const;

export class FacebookPagesAdapter implements SocialPlatformAdapter {
  readonly platform = 'FACEBOOK' as const;
  readonly capabilities = getCapabilityTable('FACEBOOK');

  private readonly client: FacebookGraphClient;
  private readonly scopes: string[];
  private readonly appSecret: string;

  constructor(config: FacebookPagesAdapterConfig) {
    this.client = new FacebookGraphClient(config);
    this.scopes = config.scopes ?? [...FACEBOOK_PAGES_OAUTH_SCOPES];
    this.appSecret = config.appSecret;
  }

  buildAuthorizationUrl(input: AuthUrlInput): string {
    return this.client.buildAuthorizationUrl({
      redirectUri: input.redirectUri,
      state: input.state,
      scopes: input.scopes.length > 0 ? input.scopes : this.scopes,
    });
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenSet> {
    const shortLivedUserToken = await this.client.exchangeCodeForUserToken(code, redirectUri);
    const userToken = await this.client.extendUserToken(shortLivedUserToken.access_token);
    const pages = await this.client.getManagedPages(userToken.access_token);
    const page = selectFacebookPage(pages);

    return mapFacebookPageToken({
      page,
      userToken,
      scopes: this.scopes,
    });
  }

  async getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile> {
    const profile = await this.client.getPageProfile(ctx.accessToken);
    return mapFacebookPageProfile(profile);
  }

  validatePost(input: PublishPostInput) {
    return validateFacebookPost(input);
  }

  async publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult> {
    const message = [input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
      .filter(Boolean)
      .join('\n\n');
    const images = input.media.filter((item) => item.type === 'IMAGE');
    const videos = input.media.filter((item) => item.type === 'VIDEO');

    if (videos.length === 1) {
      const video = videos[0];
      if (!video) throw new Error('Facebook video media không hợp lệ.');
      const result = await this.client.publishPageVideo({
        pageId: ctx.externalAccountId,
        pageAccessToken: ctx.accessToken,
        bytes: video.bytes ?? new Uint8Array(),
        fileName: fileNameFromMediaUrl(video.url, 'video.mp4'),
        mimeType: video.mimeType,
        title: input.title,
        description: message || input.description,
      });

      return {
        externalPostId: result.id,
        externalUrl: `https://www.facebook.com/${result.id}`,
        publishedAt: new Date(),
      };
    }

    if (images.length === 1) {
      const image = images[0];
      if (!image) throw new Error('Facebook photo media không hợp lệ.');
      const result = await this.client.uploadPagePhoto({
        pageId: ctx.externalAccountId,
        pageAccessToken: ctx.accessToken,
        bytes: image.bytes ?? new Uint8Array(),
        fileName: fileNameFromMediaUrl(image.url, 'image-1.jpg'),
        mimeType: image.mimeType,
        caption: message || undefined,
        published: true,
      });

      const postId = result.post_id || result.id;
      return {
        externalPostId: postId,
        externalUrl: `https://www.facebook.com/${postId}`,
        publishedAt: new Date(),
      };
    }

    const attachedMediaIds =
      images.length > 0
        ? await Promise.all(
            images.map(async (image, index) => {
              const uploaded = await this.client.uploadPagePhoto({
                pageId: ctx.externalAccountId,
                pageAccessToken: ctx.accessToken,
                bytes: image.bytes ?? new Uint8Array(),
                fileName: fileNameFromMediaUrl(image.url, `image-${index + 1}.jpg`),
                mimeType: image.mimeType,
                published: false,
              });
              return uploaded.id;
            }),
          )
        : undefined;

    const result = await this.client.publishPageFeedPost({
      pageId: ctx.externalAccountId,
      pageAccessToken: ctx.accessToken,
      message: message || undefined,
      link: attachedMediaIds?.length ? undefined : input.linkUrl,
      attachedMediaIds,
    });

    return {
      externalPostId: result.id,
      externalUrl: `https://www.facebook.com/${result.id}`,
      publishedAt: new Date(),
    };
  }

  async getPosts(): Promise<Paginated<PlatformPostData>> {
    throw capabilityUnsupported('FACEBOOK', 'getPosts');
  }

  async getComments(
    ctx: AdapterContext,
    params: SyncCommentsParams,
  ): Promise<Paginated<ReturnType<typeof mapFacebookComment>>> {
    if (!params.externalPostId) {
      throw capabilityUnsupported('FACEBOOK', 'readCommentsOnExternallyCreatedPosts');
    }

    const response = await this.client.getPostComments({
      externalPostId: params.externalPostId,
      pageAccessToken: ctx.accessToken,
      cursor: params.cursor,
      limit: params.limit,
      since: params.since,
    });

    return {
      items: response.data.map((comment) =>
        mapFacebookComment({
          comment,
          externalPostId: params.externalPostId as string,
          externalPageId: ctx.externalPageId ?? ctx.externalAccountId,
        }),
      ),
      nextCursor: response.paging?.cursors?.after ?? null,
      hasMore: Boolean(response.paging?.next),
    };
  }

  async replyToComment(
    ctx: AdapterContext,
    externalCommentId: string,
    message: string,
  ): Promise<{ externalReplyId: string; sentAt: Date }> {
    const result = await this.client.replyToComment({
      externalCommentId,
      pageAccessToken: ctx.accessToken,
      message,
    });

    return {
      externalReplyId: result.id,
      sentAt: new Date(),
    };
  }

  async getPostMetrics(_ctx: AdapterContext, _externalPostId: string): Promise<PostMetrics> {
    throw capabilityUnsupported('FACEBOOK', 'getPostMetrics');
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    return verifyMetaWebhookSignature({
      rawBody,
      headers,
      appSecret: this.appSecret,
    });
  }

  parseWebhookEvents(payload: unknown) {
    return parseMetaWebhookEvents(payload);
  }
}

function fileNameFromMediaUrl(value: string, fallback: string): string {
  const clean = value.split('?')[0]?.split('/').pop();
  return clean && clean.includes('.') ? clean : fallback;
}
