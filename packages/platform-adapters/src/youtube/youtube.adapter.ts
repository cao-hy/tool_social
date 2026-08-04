import {
  computeEngagementRate,
  emptyPostMetrics,
  metricFromApi,
  type AccountMetrics,
  type DateRange,
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
  ExternalPostPage,
  PlatformComment,
  PostMetrics,
  EditPostInput,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  SyncCommentsParams,
  SyncPostsParams,
  TokenSet,
} from '../core/types';
import {
  mapYouTubeChannelProfile,
  mapYouTubeCommentThread,
  mapYouTubeToken,
  mapYouTubePlaylistItem,
} from './youtube.mapper';
import { YouTubeClient, type YouTubeClientConfig } from './youtube.client';
import { validateYouTubePost } from './youtube.validator';

export interface YouTubeAdapterConfig extends YouTubeClientConfig {
  scopes?: string[];
}

export const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const;

const YOUTUBE_ANALYTICS_METRICS = [
  'views',
  'engagedViews',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
  'subscribersLost',
] as const;

export interface YouTubeVideoPlatformState {
  videoId: string;
  privacyStatus?: string;
  uploadStatus?: string;
  processingStatus?: string;
  processingFailureReason?: string;
  processingProgress?: {
    partsTotal?: number;
    partsProcessed?: number;
    timeLeftMs?: number;
  };
  refreshedAt: string;
}

export class YouTubeAdapter implements SocialPlatformAdapter {
  readonly platform = 'YOUTUBE' as const;
  readonly capabilities = getCapabilityTable('YOUTUBE');

  private readonly client: YouTubeClient;
  private readonly scopes: string[];

  constructor(config: YouTubeAdapterConfig) {
    this.client = new YouTubeClient(config);
    this.scopes = config.scopes ?? [...YOUTUBE_OAUTH_SCOPES];
  }

  buildAuthorizationUrl(input: AuthUrlInput): string {
    return this.client.buildAuthorizationUrl({
      redirectUri: input.redirectUri,
      state: input.state,
      scopes: input.scopes.length > 0 ? input.scopes : this.scopes,
    });
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenSet> {
    const token = await this.client.exchangeCodeForToken(code, redirectUri);
    const channel = await this.client.getMyChannel(token.access_token);
    return mapYouTubeToken({ token, scopes: this.scopes, channel });
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    const token = await this.client.refreshToken(refreshToken);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : undefined,
      scopes: token.scope?.split(/\s+/).filter(Boolean) ?? this.scopes,
      tokenType: token.token_type ?? 'Bearer',
    };
  }

  revokeToken(token: string): Promise<void> {
    return this.client.revokeToken(token);
  }

  async getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile> {
    const channel = await this.client.getMyChannel(ctx.accessToken);
    return mapYouTubeChannelProfile(channel);
  }

  async getAccountMetrics(ctx: AdapterContext, range?: DateRange): Promise<AccountMetrics> {
    const channel = await this.client.getMyChannel(ctx.accessToken);
    const metrics = emptyYouTubeAccountMetrics();
    if (channel.statistics?.subscriberCount !== undefined) {
      metrics.followers = metricFromApi(channel.statistics.subscriberCount);
    }
    const analytics = await this.readAnalyticsReport(ctx, {
      startDate: range ? isoDate(range.from) : analyticsStartDate(),
      endDate: range ? isoDate(range.to) : analyticsEndDate(),
      metrics: [...YOUTUBE_ANALYTICS_METRICS],
    });
    const analyticsRecord = analytics.report ? youtubeAnalyticsRecord(analytics.report) : {};
    const views = metricNumber(analyticsRecord.views);
    if (views !== undefined) metrics.impressions = metricFromApi(views);
    const subscribersGained = metricNumber(analyticsRecord.subscribersGained);
    const subscribersLost = metricNumber(analyticsRecord.subscribersLost);
    if (subscribersGained !== undefined || subscribersLost !== undefined) {
      metrics.followersGained = metricFromApi((subscribersGained ?? 0) - (subscribersLost ?? 0));
    }
    metrics.raw = {
      channel,
      analytics: analytics.report ?? null,
      analyticsError: analytics.error ?? null,
      platformMetrics: youtubeAccountPlatformMetrics(channel, analyticsRecord, analytics.error),
    };
    return metrics;
  }

  validatePost(input: PublishPostInput) {
    return validateYouTubePost(input);
  }

  async publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult> {
    const validation = this.validatePost(input);
    if (!validation.valid) {
      throw new Error(
        validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '),
      );
    }

    const video = input.media.find((item) => item.type === 'VIDEO');
    if (!video?.bytes?.length) throw new Error('YouTube cần bytes video từ storage để upload.');

    const options = youtubePublishOptions(input.options);
    const result = await this.client.uploadVideo({
      accessToken: ctx.accessToken,
      title: input.title?.trim() ?? 'Untitled video',
      description: input.description ?? input.caption,
      tags: input.hashtags?.map((tag) => tag.replace(/^#/, '')).filter(Boolean),
      bytes: video.bytes,
      mimeType: video.mimeType,
      privacyStatus: options.privacyStatus,
      categoryId: options.categoryId,
      selfDeclaredMadeForKids: options.selfDeclaredMadeForKids,
      containsSyntheticMedia: options.containsSyntheticMedia,
    });

    if (input.thumbnail?.bytes?.length) {
      await this.client.setThumbnail({
        accessToken: ctx.accessToken,
        videoId: result.id,
        bytes: input.thumbnail.bytes,
        mimeType: input.thumbnail.mimeType,
      });
    }

    return {
      externalPostId: result.id,
      externalUrl: `https://www.youtube.com/watch?v=${result.id}`,
      publishedAt: new Date(),
      pending: result.status?.uploadStatus
        ? !['uploaded', 'processed'].includes(result.status.uploadStatus.toLowerCase())
        : undefined,
    };
  }

  async getPosts(ctx: AdapterContext, params: SyncPostsParams): Promise<ExternalPostPage> {
    const channel = await this.client.getMyChannel(ctx.accessToken);
    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      return { items: [], hasMore: false };
    }

    const response = await this.client.getPlaylistItems(ctx.accessToken, uploadsPlaylistId, {
      pageToken: params.cursor,
      maxResults: params.limit,
    });

    return {
      items: response.items.map(mapYouTubePlaylistItem),
      nextCursor: response.nextPageToken ?? undefined,
      hasMore: Boolean(response.nextPageToken),
    };
  }

  async editPost(ctx: AdapterContext, externalPostId: string, input: EditPostInput): Promise<void> {
    const current = await this.client.getVideoStatus(ctx.accessToken, externalPostId);
    const options = youtubePublishOptions(input.options);
    const tags =
      input.hashtags?.map((tag) => tag.replace(/^#/, '')).filter(Boolean) ?? current.snippet?.tags;

    await this.client.updateVideoMetadata({
      accessToken: ctx.accessToken,
      videoId: externalPostId,
      title: input.title?.trim() || current.snippet?.title || 'Untitled video',
      description: input.description ?? input.caption ?? current.snippet?.description,
      tags,
      categoryId: options.categoryId || current.snippet?.categoryId || '22',
      privacyStatus: current.status?.privacyStatus,
      selfDeclaredMadeForKids: options.selfDeclaredMadeForKids,
    });
  }

  async deletePost(ctx: AdapterContext, externalPostId: string): Promise<void> {
    await this.client.deleteVideo(ctx.accessToken, externalPostId);
  }

  async getVideoPlatformState(
    ctx: AdapterContext,
    externalPostId: string,
  ): Promise<YouTubeVideoPlatformState> {
    const video = await this.client.getVideoStatus(ctx.accessToken, externalPostId);
    return mapVideoState(video);
  }

  async makeVideoPublic(
    ctx: AdapterContext,
    externalPostId: string,
  ): Promise<YouTubeVideoPlatformState> {
    await this.client.updateVideoPrivacy({
      accessToken: ctx.accessToken,
      videoId: externalPostId,
      privacyStatus: 'public',
    });
    const video = await this.client.getVideoStatus(ctx.accessToken, externalPostId);
    return mapVideoState(video);
  }

  async getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics> {
    const video = await this.client.getVideoStatus(ctx.accessToken, externalPostId);
    const analytics = await this.readAnalyticsReport(ctx, {
      startDate: analyticsStartDate(),
      endDate: analyticsEndDate(),
      metrics: [...YOUTUBE_ANALYTICS_METRICS],
      filters: `video==${externalPostId}`,
    });
    const analyticsRecord = analytics.report ? youtubeAnalyticsRecord(analytics.report) : {};
    const metrics = emptyPostMetrics('UNSUPPORTED');
    const analyticsViews = metricNumber(analyticsRecord.views);
    const analyticsLikes = metricNumber(analyticsRecord.likes);
    const analyticsComments = metricNumber(analyticsRecord.comments);
    const analyticsShares = metricNumber(analyticsRecord.shares);
    if (analyticsViews !== undefined) {
      metrics.views = metricFromApi(analyticsViews);
    } else if (video.statistics?.viewCount !== undefined) {
      metrics.views = metricFromApi(video.statistics.viewCount);
    }
    if (analyticsLikes !== undefined) {
      metrics.likes = metricFromApi(analyticsLikes);
    } else if (video.statistics?.likeCount !== undefined) {
      metrics.likes = metricFromApi(video.statistics.likeCount);
    }
    if (analyticsComments !== undefined) {
      metrics.comments = metricFromApi(analyticsComments);
    } else if (video.statistics?.commentCount !== undefined) {
      metrics.comments = metricFromApi(video.statistics.commentCount);
    }
    if (analyticsShares !== undefined) metrics.shares = metricFromApi(analyticsShares);

    const analyticsWatchTimeMins = metricNumber(analyticsRecord.estimatedMinutesWatched);
    const analyticsAvgWatchTimeSec = metricNumber(analyticsRecord.averageViewDuration);
    const analyticsCompletionRate = metricNumber(analyticsRecord.averageViewPercentage);

    if (analyticsWatchTimeMins !== undefined) {
      metrics.watchTime = metricFromApi(Math.round(analyticsWatchTimeMins * 60));
    }
    if (analyticsAvgWatchTimeSec !== undefined) {
      metrics.avgWatchTime = metricFromApi(Math.round(analyticsAvgWatchTimeSec));
    }
    if (analyticsCompletionRate !== undefined) {
      metrics.completionRate = metricFromApi(analyticsCompletionRate);
    }
    const engagement =
      (metrics.likes.value ?? 0) + (metrics.comments.value ?? 0) + (metrics.shares.value ?? 0);
    if (
      metrics.likes.value !== null ||
      metrics.comments.value !== null ||
      metrics.shares.value !== null
    ) {
      metrics.engagement = metricFromApi(engagement);
    }
    metrics.engagementRate = computeEngagementRate(metrics);
    metrics.raw = {
      video,
      analytics: analytics.report ?? null,
      analyticsError: analytics.error ?? null,
      platformMetrics: youtubeVideoPlatformMetrics(video, analyticsRecord, analytics.error),
    };
    return metrics;
  }

  private async readAnalyticsReport(
    ctx: AdapterContext,
    input: {
      startDate: string;
      endDate: string;
      metrics: string[];
      filters?: string;
    },
  ) {
    try {
      return {
        report: await this.client.queryAnalyticsReport({
          accessToken: ctx.accessToken,
          startDate: input.startDate,
          endDate: input.endDate,
          metrics: input.metrics,
          filters: input.filters,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.debug('YouTube Analytics API unavailable', {
        correlationId: ctx.correlationId,
        filters: input.filters,
        error: message,
      });
      return { error: message };
    }
  }

  async getComments(
    ctx: AdapterContext,
    params: SyncCommentsParams,
  ): Promise<Paginated<PlatformComment>> {
    if (!params.externalPostId) {
      throw capabilityUnsupported('YOUTUBE', 'readCommentsOnExternallyCreatedPosts');
    }

    const response = await this.client.getVideoComments({
      accessToken: ctx.accessToken,
      videoId: params.externalPostId,
      cursor: params.cursor,
      limit: params.limit,
    });
    const comments = response.items.flatMap((thread) =>
      mapYouTubeCommentThread({
        thread,
        externalPostId: params.externalPostId as string,
        externalAccountId: ctx.externalAccountId,
      }),
    );
    const filtered = params.since
      ? comments.filter((comment) => comment.postedAt >= (params.since as Date))
      : comments;

    return {
      items: filtered,
      nextCursor: response.nextPageToken ?? null,
      hasMore: Boolean(response.nextPageToken),
    };
  }

  async replyToComment(
    ctx: AdapterContext,
    externalCommentId: string,
    message: string,
  ): Promise<{ externalReplyId: string; sentAt: Date }> {
    const result = await this.client.replyToComment({
      accessToken: ctx.accessToken,
      parentCommentId: externalCommentId,
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
    const result = await this.client.createTopLevelComment({
      accessToken: ctx.accessToken,
      channelId: ctx.externalAccountId,
      videoId: externalPostId,
      message,
    });
    const comment = result.snippet.topLevelComment;

    return {
      externalCommentId: comment.id,
      postedAt: new Date(comment.snippet.publishedAt),
    };
  }

  async editComment(
    ctx: AdapterContext,
    externalCommentId: string,
    message: string,
  ): Promise<void> {
    await this.client.updateComment({
      accessToken: ctx.accessToken,
      commentId: externalCommentId,
      message,
    });
  }

  async hideComment(
    ctx: AdapterContext,
    externalCommentId: string,
    hidden: boolean,
  ): Promise<void> {
    await this.client.setCommentModerationStatus({
      accessToken: ctx.accessToken,
      commentId: externalCommentId,
      moderationStatus: hidden ? 'rejected' : 'published',
    });
  }

  async deleteComment(ctx: AdapterContext, externalCommentId: string): Promise<void> {
    await this.client.deleteComment(ctx.accessToken, externalCommentId);
  }
}

function youtubePublishOptions(options: Record<string, unknown> | undefined): {
  privacyStatus: 'public' | 'private' | 'unlisted';
  categoryId: string;
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia: boolean;
} {
  return {
    privacyStatus: readEnum(options?.privacyStatus, ['public', 'private', 'unlisted'], 'public'),
    categoryId:
      typeof options?.categoryId === 'string' && options.categoryId.trim()
        ? options.categoryId.trim()
        : '22',
    selfDeclaredMadeForKids: options?.selfDeclaredMadeForKids === true,
    containsSyntheticMedia: options?.containsSyntheticMedia === true,
  };
}

function readEnum<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function emptyYouTubeAccountMetrics(): AccountMetrics {
  const blank = { value: null, source: 'NOT_SYNCED' as const };
  return {
    followers: { ...blank },
    followersGained: { ...blank },
    reach: { ...blank },
    impressions: { ...blank },
    profileViews: { ...blank },
  };
}

function youtubeVideoPlatformMetrics(
  video: {
    statistics?: {
      viewCount?: number;
      likeCount?: number;
      commentCount?: number;
    };
    snippet?: {
      categoryId?: string;
      tags?: string[];
    };
    status?: {
      privacyStatus?: string;
      uploadStatus?: string;
    };
    processingDetails?: {
      processingStatus?: string;
    };
  },
  analytics: Record<string, unknown>,
  analyticsError?: string,
): PlatformMetricMap {
  const metrics: PlatformMetricMap = {};
  addYouTubePlatformMetric(
    metrics,
    'views',
    'Views',
    metricNumber(analytics.views) ?? video.statistics?.viewCount ?? null,
    'count',
    'Statistics',
  );
  addYouTubePlatformMetric(
    metrics,
    'engagedViews',
    'Engaged views',
    metricNumber(analytics.engagedViews) ?? null,
    'count',
    'Statistics',
  );
  addYouTubePlatformMetric(
    metrics,
    'estimatedMinutesWatched',
    'Watch time',
    metricNumber(analytics.estimatedMinutesWatched) ?? null,
    'minutes',
    'Watch time',
  );
  addYouTubePlatformMetric(
    metrics,
    'averageViewDuration',
    'Average view duration',
    metricNumber(analytics.averageViewDuration) ?? null,
    'seconds',
    'Watch time',
  );
  addYouTubePlatformMetric(
    metrics,
    'averageViewPercentage',
    'Average viewed',
    metricNumber(analytics.averageViewPercentage) ?? null,
    'percent',
    'Watch time',
  );
  addYouTubePlatformMetric(
    metrics,
    'likes',
    'Likes',
    metricNumber(analytics.likes) ?? video.statistics?.likeCount ?? null,
    'count',
    'Engagement',
  );
  addYouTubePlatformMetric(
    metrics,
    'comments',
    'Comments',
    metricNumber(analytics.comments) ?? video.statistics?.commentCount ?? null,
    'count',
    'Engagement',
  );
  addYouTubePlatformMetric(
    metrics,
    'shares',
    'Shares',
    metricNumber(analytics.shares) ?? null,
    'count',
    'Engagement',
  );
  addYouTubePlatformMetric(
    metrics,
    'categoryId',
    'Category ID',
    video.snippet?.categoryId ?? null,
    'text',
    'Metadata',
  );
  addYouTubePlatformMetric(
    metrics,
    'tagCount',
    'Tags',
    video.snippet?.tags?.length ?? null,
    'count',
    'Metadata',
  );
  addYouTubePlatformMetric(
    metrics,
    'privacyStatus',
    'Privacy',
    video.status?.privacyStatus ?? null,
    'text',
    'Status',
  );
  addYouTubePlatformMetric(
    metrics,
    'uploadStatus',
    'Upload status',
    video.status?.uploadStatus ?? null,
    'text',
    'Status',
  );
  addYouTubePlatformMetric(
    metrics,
    'processingStatus',
    'Processing',
    video.processingDetails?.processingStatus ?? null,
    'text',
    'Status',
  );
  if (analyticsError) {
    addYouTubePlatformMetric(
      metrics,
      'analyticsError',
      'Analytics API',
      analyticsError,
      'text',
      'Status',
    );
  }
  return metrics;
}

function youtubeAccountPlatformMetrics(
  channel: {
    statistics?: {
      subscriberCount?: number;
      hiddenSubscriberCount?: boolean;
    };
    snippet?: {
      title?: string;
      customUrl?: string;
    };
  },
  analytics: Record<string, unknown>,
  analyticsError?: string,
): PlatformMetricMap {
  const metrics: PlatformMetricMap = {};
  addYouTubePlatformMetric(
    metrics,
    'subscriberCount',
    'Subscribers',
    channel.statistics?.subscriberCount ?? null,
    'count',
    'Channel',
  );
  addYouTubePlatformMetric(
    metrics,
    'views',
    'Views',
    metricNumber(analytics.views) ?? null,
    'count',
    'Channel analytics',
  );
  addYouTubePlatformMetric(
    metrics,
    'engagedViews',
    'Engaged views',
    metricNumber(analytics.engagedViews) ?? null,
    'count',
    'Channel analytics',
  );
  addYouTubePlatformMetric(
    metrics,
    'estimatedMinutesWatched',
    'Watch time',
    metricNumber(analytics.estimatedMinutesWatched) ?? null,
    'minutes',
    'Watch time',
  );
  addYouTubePlatformMetric(
    metrics,
    'averageViewDuration',
    'Average view duration',
    metricNumber(analytics.averageViewDuration) ?? null,
    'seconds',
    'Watch time',
  );
  addYouTubePlatformMetric(
    metrics,
    'subscribersGained',
    'Subscribers gained',
    metricNumber(analytics.subscribersGained) ?? null,
    'count',
    'Channel analytics',
  );
  addYouTubePlatformMetric(
    metrics,
    'subscribersLost',
    'Subscribers lost',
    metricNumber(analytics.subscribersLost) ?? null,
    'count',
    'Channel analytics',
  );
  addYouTubePlatformMetric(
    metrics,
    'hiddenSubscriberCount',
    'Hidden subscribers',
    channel.statistics?.hiddenSubscriberCount ?? null,
    'text',
    'Channel',
  );
  addYouTubePlatformMetric(
    metrics,
    'title',
    'Channel title',
    channel.snippet?.title ?? null,
    'text',
    'Channel',
  );
  addYouTubePlatformMetric(
    metrics,
    'customUrl',
    'Custom URL',
    channel.snippet?.customUrl ?? null,
    'text',
    'Channel',
  );
  if (analyticsError) {
    addYouTubePlatformMetric(
      metrics,
      'analyticsError',
      'Analytics API',
      analyticsError,
      'text',
      'Status',
    );
  }
  return metrics;
}

function addYouTubePlatformMetric(
  target: PlatformMetricMap,
  key: string,
  label: string,
  value: PlatformMetricValue['value'],
  unit: PlatformMetricValue['unit'],
  group: string,
): void {
  target[key] = {
    key,
    label,
    value,
    unit,
    group,
    source: value === null ? 'NOT_SYNCED' : 'PLATFORM_API',
  };
}

function youtubeAnalyticsRecord(report: {
  columnHeaders: Array<{ name: string }>;
  rows?: Array<Array<string | number | boolean | null>>;
}): Record<string, unknown> {
  const row = report.rows?.[0];
  if (!row) return {};
  return Object.fromEntries(
    report.columnHeaders.map((header, index) => [header.name, row[index] ?? null]),
  );
}

function metricNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function analyticsStartDate(): string {
  return '2006-01-01';
}

function analyticsEndDate(): string {
  return isoDate(new Date());
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function mapVideoState(video: {
  id: string;
  status?: {
    privacyStatus?: string;
    uploadStatus?: string;
    failureReason?: string;
    rejectionReason?: string;
  };
  processingDetails?: {
    processingStatus?: string;
    processingFailureReason?: string;
    processingProgress?: {
      partsTotal?: number;
      partsProcessed?: number;
      timeLeftMs?: number;
    };
  };
}): YouTubeVideoPlatformState {
  return {
    videoId: video.id,
    privacyStatus: video.status?.privacyStatus,
    uploadStatus: video.status?.uploadStatus,
    processingStatus: video.processingDetails?.processingStatus,
    processingFailureReason:
      video.processingDetails?.processingFailureReason ??
      video.status?.failureReason ??
      video.status?.rejectionReason,
    processingProgress: video.processingDetails?.processingProgress,
    refreshedAt: new Date().toISOString(),
  };
}
