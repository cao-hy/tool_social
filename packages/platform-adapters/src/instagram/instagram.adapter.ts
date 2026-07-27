import type { Paginated } from '@socialhub/shared';
import { createUnverifiedCapabilityTable } from '../core/capability-table';
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
  TokenSet,
} from '../core/types';
import { InstagramGraphClient, type InstagramGraphClientConfig } from './instagram.client';
import { mapInstagramProfile, mapInstagramToken, selectInstagramAccount } from './instagram.mapper';
import { validateInstagramPost } from './instagram.validator';
import { parseMetaWebhookEvents, verifyMetaWebhookSignature } from '../meta/webhook';

export interface InstagramAdapterConfig extends InstagramGraphClientConfig {
  scopes?: string[];
}

export const INSTAGRAM_OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
] as const;

export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = 'INSTAGRAM' as const;
  readonly capabilities = createUnverifiedCapabilityTable('INSTAGRAM');

  private readonly client: InstagramGraphClient;
  private readonly scopes: string[];
  private readonly appSecret: string;

  constructor(config: InstagramAdapterConfig) {
    this.client = new InstagramGraphClient(config);
    this.scopes = config.scopes ?? [...INSTAGRAM_OAUTH_SCOPES];
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
    const { page, igAccountId } = selectInstagramAccount(pages);

    return mapInstagramToken({
      page,
      igAccountId,
      userToken,
      scopes: this.scopes,
    });
  }

  async getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile> {
    const profile = await this.client.getInstagramProfile(ctx.externalAccountId, ctx.accessToken);
    return mapInstagramProfile(profile);
  }

  validatePost(input: PublishPostInput) {
    return validateInstagramPost(input);
  }

  async publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult> {
    const message = [input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
      .filter(Boolean)
      .join('\n\n');

    // Instagram Graph API yêu cầu phải tải lên từng media (container) trước
    if (input.media.length === 1) {
      const media = input.media[0];
      if (!media) throw new Error('Media không hợp lệ');

      const creationId = await this.client.createMediaContainer({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        imageUrl: media.type === 'IMAGE' ? media.url : undefined,
        videoUrl: media.type === 'VIDEO' ? media.url : undefined,
        caption: message,
      });

      const postId = await this.client.publishMedia({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        creationId,
      });

      return {
        externalPostId: postId,
        externalUrl: `https://www.instagram.com/p/${postId}`,
        publishedAt: new Date(),
      };
    }

    // Xử lý Carousel (nhiều ảnh/video)
    if (input.media.length > 1) {
      // B1: Tạo container cho từng ảnh/video (is_carousel_item = true)
      const childrenIds = await Promise.all(
        input.media.map(async (media) => {
          return this.client.createMediaContainer({
            igAccountId: ctx.externalAccountId,
            accessToken: ctx.accessToken,
            imageUrl: media.type === 'IMAGE' ? media.url : undefined,
            videoUrl: media.type === 'VIDEO' ? media.url : undefined,
            isCarouselItem: true,
          });
        }),
      );

      // B2: Tạo container chính cho carousel chứa các children
      const carouselCreationId = await this.client.createMediaContainer({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        mediaType: 'CAROUSEL',
        children: childrenIds,
        caption: message,
      });

      // B3: Publish carousel container
      const postId = await this.client.publishMedia({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        creationId: carouselCreationId,
      });

      return {
        externalPostId: postId,
        externalUrl: `https://www.instagram.com/p/${postId}`,
        publishedAt: new Date(),
      };
    }

    throw new Error('Cần ít nhất một ảnh hoặc video để đăng lên Instagram.');
  }

  async getPosts(): Promise<Paginated<PlatformPostData>> {
    throw capabilityUnsupported('INSTAGRAM', 'getPosts');
  }

  async getPostMetrics(_ctx: AdapterContext, _externalPostId: string): Promise<PostMetrics> {
    throw capabilityUnsupported('INSTAGRAM', 'getPostMetrics');
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
