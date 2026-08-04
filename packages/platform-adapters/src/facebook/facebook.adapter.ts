import {
  computeEngagementRate,
  derivedMetric,
  emptyPostMetrics,
  metricFromApi,
  type AccountMetrics,
  type Paginated,
  type PlatformMetricMap,
  type PlatformMetricValue,
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

  async getAccountMetrics(ctx: AdapterContext): Promise<AccountMetrics> {
    const profile = await this.client.getPageProfile(ctx.accessToken);
    const metrics = emptyFacebookAccountMetrics();
    const raw: Record<string, unknown> = {
      profile: {
        fanCount: profile.fan_count ?? null,
      },
    };

    if (profile.fan_count !== undefined) metrics.followers = metricFromApi(profile.fan_count);

    const insights = await this.readAvailablePageInsights(ctx, FACEBOOK_PAGE_METRICS);
    raw.insights = insights;

    const mediaViews = firstNumber(insights, ['page_media_view', 'page_impressions']);
    const uniqueMediaViews = firstNumber(insights, [
      'page_total_media_view_unique',
      'page_impressions_unique',
    ]);
    const follows = firstNumber(insights, ['page_follows', 'page_fan_adds']);
    const unfollows = firstNumber(insights, ['page_fan_removes']);
    const profileViews = firstNumber(insights, ['page_views_total']);

    if (mediaViews !== undefined) metrics.impressions = metricFromApi(mediaViews);
    if (uniqueMediaViews !== undefined) metrics.reach = metricFromApi(uniqueMediaViews);
    if (follows !== undefined && unfollows !== undefined) {
      metrics.followersGained = derivedMetric(follows - unfollows);
    } else if (follows !== undefined) {
      metrics.followersGained = metricFromApi(follows);
    }
    if (profileViews !== undefined) metrics.profileViews = metricFromApi(profileViews);
    raw.normalized = {
      mediaViews: mediaViews ?? null,
      uniqueMediaViews: uniqueMediaViews ?? null,
      follows: follows ?? null,
      unfollows: unfollows ?? null,
      profileViews: profileViews ?? null,
    };
    raw.platformMetrics = facebookPlatformMetrics({
      ...insights,
      fan_count: profile.fan_count ?? null,
      mediaViews: mediaViews ?? null,
      uniqueMediaViews: uniqueMediaViews ?? null,
      follows: follows ?? null,
      unfollows: unfollows ?? null,
      profileViews: profileViews ?? null,
    });

    metrics.raw = raw;
    return metrics;
  }

  validatePost(input: PublishPostInput) {
    return validateFacebookPost(input);
  }

  async publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult> {
    const message = [input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
      .filter(Boolean)
      .join('\n\n');
    const options = facebookPublishOptions(input.options);
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
        title: options.videoTitle ?? input.title,
        description: message || input.description,
        placeId: options.placeId,
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
        altText: options.photoAltText ?? image.altText,
        placeId: options.placeId,
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
                altText: options.photoAltText ?? image.altText,
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
      placeId: options.placeId,
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

  async createComment(
    ctx: AdapterContext,
    externalPostId: string,
    message: string,
  ): Promise<{ externalCommentId: string; postedAt: Date }> {
    const result = await this.client.createPostComment({
      externalPostId,
      pageAccessToken: ctx.accessToken,
      message,
    });

    return {
      externalCommentId: result.id,
      postedAt: new Date(),
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
    const raw: Record<string, unknown> = {};

    const engagement = await this.client.getPostEngagement({
      externalPostId,
      pageAccessToken: ctx.accessToken,
    });
    const likes = engagement.reactions?.summary?.total_count;
    const comments = engagement.comments?.summary?.total_count;
    const shares = engagement.shares?.count;

    raw.engagementFields = {
      reactions: likes ?? null,
      comments: comments ?? null,
      shares: shares ?? null,
    };

    if (likes !== undefined) metrics.likes = metricFromApi(likes);
    if (comments !== undefined) metrics.comments = metricFromApi(comments);
    if (shares !== undefined) metrics.shares = metricFromApi(shares);

    const insights = await this.readAvailablePostInsights(
      ctx,
      externalPostId,
      FACEBOOK_POST_METRICS,
    );
    raw.insights = insights;

    const views = firstNumber(insights, [
      'post_media_view',
      'post_video_views',
      'post_video_views_15s',
      'post_video_complete_views_30s',
    ]);
    const reach = firstNumber(insights, [
      'post_total_media_view_unique',
      'post_impressions_unique',
      'post_video_views_unique',
      'post_video_complete_views_30s_unique',
    ]);
    const impressions = firstNumber(insights, ['post_impressions', 'post_media_view']);
    const engagedUsers = firstNumber(insights, ['post_engaged_users']);
    const clicks = firstNumber(insights, ['post_clicks']);
    const reactionBreakdown = numberRecord(insights.post_reactions_by_type_total);
    const reactionBreakdownTotal = sumRecordValues(reactionBreakdown);

    raw.normalized = {
      views: views ?? null,
      reach: reach ?? null,
      impressions: impressions ?? null,
      engagedUsers: engagedUsers ?? null,
      clicks: clicks ?? null,
      reactionBreakdown,
    };
    raw.platformMetrics = facebookPlatformMetrics({
      ...insights,
      reactions: likes ?? null,
      comments: comments ?? null,
      shares: shares ?? null,
      views: views ?? null,
      reach: reach ?? null,
      impressions: impressions ?? null,
      engagedUsers: engagedUsers ?? null,
      clicks: clicks ?? null,
      ...(reactionBreakdown
        ? Object.fromEntries(
            Object.entries(reactionBreakdown).map(([key, value]) => [`reaction_${key}`, value]),
          )
        : {}),
    });

    const watchTime = firstNumber(insights, ['post_video_view_time']);
    const avgWatchTime = firstNumber(insights, ['post_video_avg_time_watched']);
    const linkClicks = numberRecord(insights.post_clicks_by_type)?.['link clicks'];

    if (views !== undefined) metrics.views = metricFromApi(views);
    if (impressions !== undefined) metrics.impressions = metricFromApi(impressions);
    if (reach !== undefined) metrics.reach = metricFromApi(reach);
    if (clicks !== undefined) metrics.clicks = metricFromApi(clicks);
    if (linkClicks !== undefined) metrics.linkClicks = metricFromApi(linkClicks);
    if (watchTime !== undefined) metrics.watchTime = metricFromApi(Math.round(watchTime / 1000));
    if (avgWatchTime !== undefined)
      metrics.avgWatchTime = metricFromApi(Math.round(avgWatchTime / 1000));

    if (reactionBreakdownTotal !== undefined && likes === undefined) {
      metrics.likes = metricFromApi(reactionBreakdownTotal);
    }

    if (engagedUsers !== undefined) {
      metrics.engagement = metricFromApi(engagedUsers);
    } else if (likes !== undefined || comments !== undefined || shares !== undefined) {
      metrics.engagement = metricFromApi((likes ?? 0) + (comments ?? 0) + (shares ?? 0));
    }

    metrics.engagementRate = computeEngagementRate(metrics);
    metrics.raw = raw;
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
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.getPostInsights({
        externalPostId,
        pageAccessToken: ctx.accessToken,
        metrics,
      });
      return Object.fromEntries(
        response.data.flatMap((item) => {
          const value = readFacebookInsightValue(item.values?.at(-1)?.value);
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

  private async readAvailablePostInsights(
    ctx: AdapterContext,
    externalPostId: string,
    metrics: readonly string[],
  ): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      metrics.map(async (metric) => {
        const result = await this.readPostInsights(ctx, externalPostId, [metric]);
        return [metric, result[metric]] as const;
      }),
    );
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  }

  private async readPageInsights(
    ctx: AdapterContext,
    metrics: readonly string[],
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.getPageInsights({
        pageAccessToken: ctx.accessToken,
        metrics: [...metrics],
      });
      return Object.fromEntries(
        response.data.flatMap((item) => {
          const value = readFacebookInsightValue(item.values?.at(-1)?.value);
          return value === undefined ? [] : [[item.name, value]];
        }),
      );
    } catch (error) {
      ctx.logger?.debug('Facebook page insights unavailable', {
        correlationId: ctx.correlationId,
        metrics,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  private async readAvailablePageInsights(
    ctx: AdapterContext,
    metrics: readonly string[],
  ): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      metrics.map(async (metric) => {
        const result = await this.readPageInsights(ctx, [metric]);
        return [metric, result[metric]] as const;
      }),
    );
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  }
}

function emptyFacebookAccountMetrics(): AccountMetrics {
  const metric = { value: null, source: 'UNSUPPORTED' as const };
  return {
    followers: { ...metric },
    followersGained: { ...metric },
    reach: { ...metric },
    impressions: { ...metric },
    profileViews: { ...metric },
  };
}

const FACEBOOK_POST_METRICS = [
  'post_media_view',
  'post_total_media_view_unique',
  'post_media_view_paid',
  'post_media_view_organic',
  'post_media_view_followers',
  'post_impressions',
  'post_impressions_unique',
  'post_impressions_paid',
  'post_impressions_organic',
  'post_impressions_fan',
  'post_impressions_fan_paid',
  'post_engaged_users',
  'post_clicks',
  'post_clicks_by_type',
  'post_reactions_by_type_total',
  'post_negative_feedback',
  'post_negative_feedback_by_type',
  'post_video_views',
  'post_video_views_unique',
  'post_video_views_15s',
  'post_video_views_60s_excludes_shorter',
  'post_video_complete_views_30s',
  'post_video_complete_views_30s_unique',
  'post_video_avg_time_watched',
  'post_video_view_time',
] as const;

const FACEBOOK_PAGE_METRICS = [
  'page_media_view',
  'page_total_media_view_unique',
  'page_media_view_paid',
  'page_media_view_organic',
  'page_media_view_followers',
  'page_impressions',
  'page_impressions_unique',
  'page_post_engagements',
  'page_follows',
  'page_fan_adds',
  'page_fan_removes',
  'page_views_total',
  'page_video_views',
  'page_video_complete_views_30s',
] as const;

function fileNameFromMediaUrl(value: string, fallback: string): string {
  const clean = value.split('?')[0]?.split('/').pop();
  return clean && clean.includes('.') ? clean : fallback;
}

function readFacebookInsightValue(value: unknown): unknown {
  const number = readFacebookInsightNumber(value);
  if (number !== undefined) return number;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return undefined;
}

function readFacebookInsightNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readFacebookInsightNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const number = readFacebookInsightNumber(item);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sumRecordValues(record: Record<string, number> | undefined): number | undefined {
  if (!record) return undefined;
  return Object.values(record).reduce((total, value) => total + value, 0);
}

function facebookPublishOptions(options: Record<string, unknown> | undefined): {
  placeId?: string;
  photoAltText?: string;
  videoTitle?: string;
} {
  return {
    placeId: readOptionalString(options?.placeId),
    photoAltText: readOptionalString(options?.photoAltText),
    videoTitle: readOptionalString(options?.videoTitle),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function facebookPlatformMetrics(record: Record<string, unknown>): PlatformMetricMap {
  const metrics: PlatformMetricMap = {};
  for (const [key, value] of Object.entries(record)) {
    const primitive = facebookMetricPrimitive(value);
    if (primitive === null && value !== null) continue;
    metrics[key] = {
      key,
      label: facebookMetricLabel(key),
      value: primitive,
      unit: facebookMetricUnit(key),
      group: facebookMetricGroup(key),
      source: primitive === null ? 'NOT_SYNCED' : 'PLATFORM_API',
    };
  }
  return metrics;
}

function facebookMetricPrimitive(value: unknown): PlatformMetricValue['value'] {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  return null;
}

function facebookMetricLabel(key: string): string {
  return key
    .replace(/^post_/, '')
    .replace(/^page_/, '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function facebookMetricUnit(key: string): PlatformMetricValue['unit'] {
  if (key.includes('rate')) return 'percent';
  return 'count';
}

function facebookMetricGroup(key: string): string {
  if (key.includes('video') || key.includes('media_view') || key === 'views') return 'Video';
  if (key.includes('reaction') || key.includes('comment') || key.includes('share')) {
    return 'Engagement';
  }
  if (key.includes('click')) return 'Traffic';
  if (key.includes('fan') || key.includes('follow') || key.includes('profile')) return 'Page';
  return 'Distribution';
}
