import {
  computeEngagementRate,
  emptyPostMetrics,
  metricFromApi,
  type Paginated,
} from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import { capabilityUnsupported } from '../core/platform-error';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  PostMetrics,
  EditPostInput,
  ExternalPostPage,
  SyncCommentsParams,
  SyncPostsParams,
  TokenSet,
} from '../core/types';
import { FacebookGraphClient, type FacebookGraphClientConfig } from './facebook.client';
import {
  mapFacebookComment,
  mapFacebookPageProfile,
  mapFacebookPageToken,
  selectFacebookPage,
  mapFacebookPagePost,
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
      ctx.logger?.info('Facebook publish video upload request', {
        correlationId: ctx.correlationId,
        pageId: ctx.externalAccountId,
        mediaType: video.type,
        mimeType: video.mimeType,
        sizeBytes: video.sizeBytes,
        byteLength: video.bytes?.byteLength ?? 0,
      });
      const result = await this.client.publishPageVideo({
        pageId: ctx.externalAccountId,
        pageAccessToken: ctx.accessToken,
        bytes: video.bytes ?? new Uint8Array(),
        fileName: fileNameFromMediaUrl(video.url, 'video.mp4'),
        mimeType: video.mimeType,
        title: input.title,
        description: message || input.description,
        thumbnail: input.thumbnail
          ? {
              bytes: input.thumbnail.bytes ?? new Uint8Array(),
              fileName: fileNameFromMediaUrl(input.thumbnail.url, 'thumbnail.jpg'),
              mimeType: input.thumbnail.mimeType,
            }
          : undefined,
      });

      if (input.thumbnail?.bytes?.byteLength) {
        try {
          await this.client.setVideoThumbnail({
            videoId: result.id,
            pageAccessToken: ctx.accessToken,
            bytes: input.thumbnail.bytes,
            fileName: 'thumbnail.jpg',
            mimeType: input.thumbnail.mimeType,
          });
          ctx.logger?.info('Facebook video thumbnail preferred request succeeded', {
            correlationId: ctx.correlationId,
            videoId: result.id,
          });
        } catch (error) {
          ctx.logger?.warn('Facebook video thumbnail preferred request failed', {
            correlationId: ctx.correlationId,
            videoId: result.id,
            err: error,
          });
        }
      }

      return {
        externalPostId: result.id,
        externalUrl: `https://www.facebook.com/${result.id}`,
        publishedAt: new Date(),
      };
    }

    if (images.length === 1) {
      const image = images[0];
      if (!image) throw new Error('Facebook photo media không hợp lệ.');
      ctx.logger?.info('Facebook publish photo upload request', {
        correlationId: ctx.correlationId,
        pageId: ctx.externalAccountId,
        mediaType: image.type,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        byteLength: image.bytes?.byteLength ?? 0,
      });
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
              ctx.logger?.info('Facebook unpublished photo upload request', {
                correlationId: ctx.correlationId,
                pageId: ctx.externalAccountId,
                mediaType: image.type,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                byteLength: image.bytes?.byteLength ?? 0,
                index,
              });
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

  async getPosts(ctx: AdapterContext, params: SyncPostsParams): Promise<ExternalPostPage> {
    const response = await this.client.getPagePosts({
      pageId: ctx.externalAccountId,
      pageAccessToken: ctx.accessToken,
      cursor: params.cursor,
      limit: params.limit,
      since: params.since,
    });

    return {
      items: response.data.map(mapFacebookPagePost),
      nextCursor: response.paging?.cursors?.after ?? undefined,
      hasMore: Boolean(response.paging?.next),
    };
  }

  async editPost(ctx: AdapterContext, externalPostId: string, input: EditPostInput): Promise<void> {
    const message = [
      input.caption ?? input.description,
      input.hashtags?.map((tag) => `#${tag}`).join(' '),
    ]
      .filter(Boolean)
      .join('\n\n');
    const isVideoPost = input.mediaTypes?.includes('VIDEO') ?? false;

    ctx.logger?.info(
      `Facebook edit post request ${JSON.stringify({
        correlationId: ctx.correlationId,
        externalPostId,
        externalAccountId: ctx.externalAccountId,
        mode: isVideoPost ? 'video' : 'feed',
        hasMessage: message.length > 0,
        messageLength: message.length,
        hasLink: input.linkUrl !== undefined,
      })}`,
    );

    const result = isVideoPost
      ? await this.client.updatePageVideo({
          externalPostId,
          pageAccessToken: ctx.accessToken,
          title: input.title,
          description: message || input.description,
        })
      : await this.client.updatePagePost({
          externalPostId,
          pageAccessToken: ctx.accessToken,
          message: message || undefined,
          link: input.linkUrl,
        });

    ctx.logger?.info(
      `Facebook edit post response ${JSON.stringify({
        correlationId: ctx.correlationId,
        externalPostId,
        mode: isVideoPost ? 'video' : 'feed',
        success: result.success,
        id: result.id,
      })}`,
    );
  }

  async deletePost(ctx: AdapterContext, externalPostId: string): Promise<void> {
    ctx.logger?.info(
      `Facebook delete post request ${JSON.stringify({
        correlationId: ctx.correlationId,
        externalPostId,
        externalAccountId: ctx.externalAccountId,
      })}`,
    );

    const result = await this.client.deletePagePost({
      externalPostId,
      pageAccessToken: ctx.accessToken,
    });

    ctx.logger?.info(
      `Facebook delete post response ${JSON.stringify({
        correlationId: ctx.correlationId,
        externalPostId,
        success: result.success,
        id: result.id,
      })}`,
    );
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

  async deleteComment(ctx: AdapterContext, externalCommentId: string): Promise<void> {
    await this.client.deleteComment({
      externalCommentId,
      pageAccessToken: ctx.accessToken,
    });
  }

  async hideComment(
    ctx: AdapterContext,
    externalCommentId: string,
    hidden: boolean,
  ): Promise<void> {
    await this.client.hideComment({
      externalCommentId,
      pageAccessToken: ctx.accessToken,
      hidden,
    });
  }

  async getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics> {
    const metrics = emptyPostMetrics('UNSUPPORTED');

    const engagement = await this.client.getPostEngagement({
      externalPostId,
      pageAccessToken: ctx.accessToken,
    });
    const likes = engagement.reactions?.summary?.total_count;
    const comments = engagement.comments?.summary?.total_count;
    const shares = engagement.shares?.count;

    if (likes !== undefined) metrics.likes = metricFromApi(likes);
    if (comments !== undefined) metrics.comments = metricFromApi(comments);
    if (shares !== undefined) metrics.shares = metricFromApi(shares);

    const insights = await this.readPostInsights(ctx, externalPostId, [
      'post_impressions',
      'post_impressions_unique',
      'post_engaged_users',
    ]);

    if (insights.post_impressions !== undefined) {
      metrics.impressions = metricFromApi(insights.post_impressions);
    }
    if (insights.post_impressions_unique !== undefined) {
      metrics.reach = metricFromApi(insights.post_impressions_unique);
    }
    if (insights.post_engaged_users !== undefined) {
      metrics.engagement = metricFromApi(insights.post_engaged_users);
    } else if (likes !== undefined || comments !== undefined || shares !== undefined) {
      metrics.engagement = metricFromApi((likes ?? 0) + (comments ?? 0) + (shares ?? 0));
    }

    metrics.engagementRate = computeEngagementRate(metrics);
    return metrics;
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

  private async readPostInsights(
    ctx: AdapterContext,
    externalPostId: string,
    metrics: string[],
  ): Promise<Record<string, number>> {
    try {
      const response = await this.client.getPostInsights({
        externalPostId,
        pageAccessToken: ctx.accessToken,
        metrics,
      });
      return Object.fromEntries(
        response.data.flatMap((item) => {
          const value = readFacebookInsightNumber(item.values?.at(-1)?.value);
          return value === undefined ? [] : [[item.name, value]];
        }),
      );
    } catch (error) {
      ctx.logger?.debug('Facebook post insights unavailable', {
        correlationId: ctx.correlationId,
        externalPostId,
        metrics,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
}

function fileNameFromMediaUrl(value: string, fallback: string): string {
  const clean = value.split('?')[0]?.split('/').pop();
  return clean && clean.includes('.') ? clean : fallback;
}

function readFacebookInsightNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
