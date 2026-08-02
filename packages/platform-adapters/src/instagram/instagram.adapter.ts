import {
  computeEngagementRate,
  emptyPostMetrics,
  metricFromApi,
  type Paginated,
} from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import { capabilityUnsupported, createPlatformError } from '../core/platform-error';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  ExternalPostPage,
  PlatformComment,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  PostMetrics,
  SyncCommentsParams,
  SyncPostsParams,
  TokenSet,
} from '../core/types';
import { InstagramGraphClient, type InstagramGraphClientConfig } from './instagram.client';
import {
  mapInstagramProfile,
  mapInstagramToken,
  selectInstagramAccount,
  mapInstagramMedia,
} from './instagram.mapper';
import type { InstagramComment, InstagramContainerStatus } from './instagram.schemas';
import { validateInstagramPost } from './instagram.validator';
import { parseMetaWebhookEvents, verifyMetaWebhookSignature } from '../meta/webhook';

export interface InstagramAdapterConfig extends InstagramGraphClientConfig {
  scopes?: string[];
}

export const INSTAGRAM_OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
] as const;

export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = 'INSTAGRAM' as const;
  readonly capabilities = getCapabilityTable('INSTAGRAM');

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
    const profile = await this.client.getInstagramProfile(igAccountId, page.access_token);

    return mapInstagramToken({
      page,
      igAccountId,
      profile,
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
    const options = instagramPublishOptions(input.options);

    // Instagram Graph API yêu cầu phải tải lên từng media (container) trước
    if (input.media.length === 1) {
      const media = input.media[0];
      if (!media) throw new Error('Media không hợp lệ');
      const mediaType = media.type === 'VIDEO' ? (options.mediaType ?? 'REELS') : options.mediaType;

      const creationId = await this.client.createMediaContainer({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        imageUrl: media.type === 'IMAGE' ? media.url : undefined,
        videoUrl: media.type === 'VIDEO' ? media.url : undefined,
        caption: message,
        mediaType: mediaType === 'REELS' || mediaType === 'STORIES' ? mediaType : undefined,
        shareToFeed: mediaType === 'REELS' ? options.shareToFeed : undefined,
        coverUrl:
          media.type === 'VIDEO' && mediaType === 'REELS' ? input.thumbnail?.url : undefined,
      });
      if (media.type === 'VIDEO') {
        await this.waitUntilContainerReady(ctx, creationId, 'video');
      }

      const postId = await this.client.publishMedia({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        creationId,
      });

      const publishedMedia = await this.client.getMedia({
        mediaId: postId,
        accessToken: ctx.accessToken,
      });

      return {
        externalPostId: postId,
        externalUrl: publishedMedia.permalink ?? `https://www.instagram.com/p/${postId}`,
        publishedAt: new Date(),
      };
    }

    // Xử lý Carousel (nhiều ảnh/video)
    if (input.media.length > 1) {
      // B1: Tạo container cho từng ảnh/video (is_carousel_item = true)
      const childrenIds = await Promise.all(
        input.media.map(async (media) => {
          const childId = await this.client.createMediaContainer({
            igAccountId: ctx.externalAccountId,
            accessToken: ctx.accessToken,
            imageUrl: media.type === 'IMAGE' ? media.url : undefined,
            videoUrl: media.type === 'VIDEO' ? media.url : undefined,
            isCarouselItem: true,
          });
          await this.waitUntilContainerReady(
            ctx,
            childId,
            media.type === 'VIDEO' ? 'video' : 'image',
          );
          return childId;
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
      await this.waitUntilContainerReady(ctx, carouselCreationId, 'carousel');

      // B3: Publish carousel container
      const postId = await this.client.publishMedia({
        igAccountId: ctx.externalAccountId,
        accessToken: ctx.accessToken,
        creationId: carouselCreationId,
      });

      const media = await this.client.getMedia({
        mediaId: postId,
        accessToken: ctx.accessToken,
      });

      return {
        externalPostId: postId,
        externalUrl: media.permalink ?? `https://www.instagram.com/p/${postId}`,
        publishedAt: new Date(),
      };
    }

    throw new Error('Cần ít nhất một ảnh hoặc video để đăng lên Instagram.');
  }

  private async waitUntilContainerReady(
    ctx: AdapterContext,
    containerId: string,
    mediaKind: 'image' | 'video' | 'carousel',
  ): Promise<void> {
    const attempts = mediaKind === 'video' ? 8 : 5;
    const delaysMs =
      mediaKind === 'video'
        ? [2000, 3000, 5000, 8000, 13000, 21000, 30000]
        : [1000, 1500, 2500, 4000];

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const status = await this.client.getContainerStatus({
        containerId,
        accessToken: ctx.accessToken,
      });
      ctx.logger?.debug('Instagram container status', {
        correlationId: ctx.correlationId,
        containerId,
        attempt,
        statusCode: status.status_code,
        status: status.status,
      });

      if (status.status_code === 'FINISHED' || status.status_code === 'PUBLISHED') return;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw instagramContainerError(containerId, status);
      }

      const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 5000;
      await sleep(delayMs);
    }

    throw createPlatformError(
      'VALIDATION',
      'INSTAGRAM',
      'Instagram media container chưa xử lý xong. Hãy thử publish lại sau vài phút hoặc kiểm tra định dạng media.',
      {
        platformCode: 'CONTAINER_NOT_READY',
        raw: { containerId, mediaKind },
      },
    );
  }

  async getPosts(ctx: AdapterContext, params: SyncPostsParams): Promise<ExternalPostPage> {
    const response = await this.client.getUserMedia({
      igAccountId: ctx.externalAccountId,
      accessToken: ctx.accessToken,
      cursor: params.cursor,
      limit: params.limit,
      since: params.since,
    });
    const items = response.data.map(mapInstagramMedia);

    return {
      items,
      nextCursor: response.paging?.cursors?.after ?? undefined,
      hasMore: Boolean(response.paging?.next),
    };
  }

  async getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics> {
    const media = await this.client.getMedia({
      mediaId: externalPostId,
      accessToken: ctx.accessToken,
    });
    const metrics = emptyPostMetrics('UNSUPPORTED');

    if (media.like_count !== undefined) metrics.likes = metricFromApi(media.like_count);
    if (media.comments_count !== undefined) metrics.comments = metricFromApi(media.comments_count);

    const insightValues = await this.readAvailableInsights(ctx, externalPostId, [
      'impressions',
      'reach',
      'saved',
      'shares',
      'plays',
      'video_views',
    ]);

    if (insightValues.impressions !== undefined) {
      metrics.impressions = metricFromApi(insightValues.impressions);
    }
    if (insightValues.reach !== undefined) metrics.reach = metricFromApi(insightValues.reach);
    if (insightValues.saved !== undefined) metrics.saves = metricFromApi(insightValues.saved);
    if (insightValues.shares !== undefined) metrics.shares = metricFromApi(insightValues.shares);
    if (insightValues.plays !== undefined) metrics.views = metricFromApi(insightValues.plays);
    if (insightValues.video_views !== undefined) {
      metrics.views = metricFromApi(insightValues.video_views);
    }

    const engagement =
      (metrics.likes.value ?? 0) +
      (metrics.comments.value ?? 0) +
      (metrics.shares.value ?? 0) +
      (metrics.saves.value ?? 0);
    if (
      metrics.likes.value !== null ||
      metrics.comments.value !== null ||
      metrics.shares.value !== null ||
      metrics.saves.value !== null
    ) {
      metrics.engagement = metricFromApi(engagement);
    }
    metrics.engagementRate = computeEngagementRate(metrics);
    return metrics;
  }

  async getComments(
    ctx: AdapterContext,
    params: SyncCommentsParams,
  ): Promise<Paginated<PlatformComment>> {
    if (!params.externalPostId) {
      throw capabilityUnsupported('INSTAGRAM', 'readCommentsOnExternallyCreatedPosts');
    }

    const response = await this.client.getMediaComments({
      mediaId: params.externalPostId,
      accessToken: ctx.accessToken,
      cursor: params.cursor,
      limit: params.limit,
    });
    const comments = response.data.map((comment) =>
      mapInstagramComment({
        comment,
        externalPostId: params.externalPostId as string,
        externalAccountId: ctx.externalAccountId,
      }),
    );
    const filtered = params.since
      ? comments.filter((comment) => comment.postedAt >= (params.since as Date))
      : comments;

    return {
      items: filtered,
      nextCursor: response.paging?.cursors?.after ?? null,
      hasMore: Boolean(response.paging?.next),
    };
  }

  async replyToComment(
    ctx: AdapterContext,
    externalCommentId: string,
    message: string,
  ): Promise<{ externalReplyId: string; sentAt: Date }> {
    const id = await this.client.replyToComment({
      commentId: externalCommentId,
      accessToken: ctx.accessToken,
      message,
    });

    return {
      externalReplyId: id,
      sentAt: new Date(),
    };
  }

  async deleteComment(ctx: AdapterContext, externalCommentId: string): Promise<void> {
    await this.client.deleteComment({
      commentId: externalCommentId,
      accessToken: ctx.accessToken,
    });
  }

  async hideComment(
    ctx: AdapterContext,
    externalCommentId: string,
    hidden: boolean,
  ): Promise<void> {
    await this.client.hideComment({
      commentId: externalCommentId,
      accessToken: ctx.accessToken,
      hidden,
    });
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

  private async readAvailableInsights(
    ctx: AdapterContext,
    externalPostId: string,
    metrics: string[],
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};

    await Promise.all(
      metrics.map(async (metric) => {
        try {
          const response = await this.client.getMediaInsights({
            mediaId: externalPostId,
            accessToken: ctx.accessToken,
            metrics: [metric],
          });
          const value = response.data[0]?.values[0]?.value;
          if (typeof value === 'number') result[metric] = value;
        } catch (error) {
          ctx.logger?.debug('Instagram insight metric unavailable', {
            correlationId: ctx.correlationId,
            externalPostId,
            metric,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return result;
  }
}

function mapInstagramComment(input: {
  comment: InstagramComment;
  externalPostId: string;
  externalAccountId: string;
}): PlatformComment {
  return {
    externalCommentId: input.comment.id,
    externalPostId: input.externalPostId,
    authorExternalId: input.comment.username,
    authorName: input.comment.username,
    message: input.comment.text,
    likeCount: input.comment.like_count,
    postedAt: input.comment.timestamp ? new Date(input.comment.timestamp) : new Date(),
    isHidden: input.comment.hidden,
    isFromOwner: input.comment.username === input.externalAccountId,
  };
}

function instagramPublishOptions(options: Record<string, unknown> | undefined): {
  mediaType?: 'FEED' | 'CAROUSEL' | 'REELS' | 'STORIES';
  shareToFeed?: boolean;
} {
  const rawMediaType = options?.mediaType;
  const mediaType =
    rawMediaType === 'STORY'
      ? 'STORIES'
      : readEnum(rawMediaType, ['FEED', 'CAROUSEL', 'REELS', 'STORIES'], undefined);
  return {
    mediaType,
    shareToFeed: options?.shareToFeed === true,
  };
}

function instagramContainerError(containerId: string, status: InstagramContainerStatus) {
  return createPlatformError(
    'VALIDATION',
    'INSTAGRAM',
    status.status
      ? `Instagram từ chối media container: ${status.status}`
      : 'Instagram từ chối media container. Hãy kiểm tra định dạng, tỷ lệ khung hình, codec hoặc URL media public.',
    {
      platformCode: status.status_code ?? 'CONTAINER_ERROR',
      raw: { containerId, status },
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | undefined,
): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}
