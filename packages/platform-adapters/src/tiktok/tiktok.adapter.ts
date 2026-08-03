import {
  computeEngagementRate,
  emptyPostMetrics,
  metricFromApi,
  type AccountMetrics,
  type PlatformMetricMap,
  type PlatformMetricValue,
} from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  ExternalPostPage,
  PostMetrics,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  SyncPostsParams,
  TikTokCreatorInfo,
  TokenSet,
} from '../core/types';
import { TikTokClient, type TikTokClientConfig } from './tiktok.client';
import { mapTikTokProfile, mapTikTokToken, mapTikTokVideo } from './tiktok.mapper';
import { validateTikTokPost } from './tiktok.validator';

export interface TikTokAdapterConfig extends TikTokClientConfig {
  scopes?: string[];
}

export const TIKTOK_OAUTH_SCOPES = [
  'user.info.basic',
  'video.upload',
  'video.publish',
  'video.list',
] as const;

export interface TikTokPublishPlatformState {
  publishId: string;
  status?: string;
  failReason?: string;
  publiclyAvailablePostIds?: string[];
  uploadedBytes?: number;
  refreshedAt: string;
}

export class TikTokAdapter implements SocialPlatformAdapter {
  readonly platform = 'TIKTOK' as const;
  readonly capabilities = getCapabilityTable('TIKTOK');

  private readonly client: TikTokClient;
  private readonly scopes: string[];

  constructor(config: TikTokAdapterConfig) {
    this.client = new TikTokClient(config);
    this.scopes = config.scopes ?? [...TIKTOK_OAUTH_SCOPES];
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
    const profile = await this.client.getUserInfo(token.access_token);
    return mapTikTokToken({ token, scopes: this.scopes, profile: profile.data.user });
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    const token = await this.client.refreshToken(refreshToken);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : undefined,
      refreshTokenExpiresAt: token.refresh_expires_in
        ? new Date(Date.now() + token.refresh_expires_in * 1000)
        : undefined,
      scopes:
        token.scope
          ?.split(',')
          .map((scope) => scope.trim())
          .filter(Boolean) ?? this.scopes,
      tokenType: token.token_type ?? 'Bearer',
    };
  }

  revokeToken(token: string): Promise<void> {
    return this.client.revokeToken(token);
  }

  async getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile> {
    const profile = await this.client.getUserInfo(ctx.accessToken);
    return mapTikTokProfile(profile.data.user);
  }

  async getAccountMetrics(ctx: AdapterContext): Promise<AccountMetrics> {
    const profile = await this.client.getUserInfo(ctx.accessToken);
    const metrics = emptyTikTokAccountMetrics();
    if (profile.data.user.follower_count !== undefined) {
      metrics.followers = metricFromApi(profile.data.user.follower_count);
    }
    metrics.raw = {
      profile: profile.data.user,
      platformMetrics: tiktokAccountPlatformMetrics(profile.data.user),
    };
    return metrics;
  }

  async queryCreatorInfo(ctx: AdapterContext): Promise<TikTokCreatorInfo> {
    const creator = await this.client.queryCreatorInfo(ctx.accessToken);
    return {
      creatorAvatarUrl: creator.data.creator_avatar_url ?? undefined,
      creatorUsername: creator.data.creator_username ?? undefined,
      creatorNickname: creator.data.creator_nickname ?? undefined,
      privacyLevelOptions: creator.data.privacy_level_options ?? [],
      commentDisabled: creator.data.comment_disabled ?? false,
      duetDisabled: creator.data.duet_disabled ?? false,
      stitchDisabled: creator.data.stitch_disabled ?? false,
      maxVideoPostDurationSec: creator.data.max_video_post_duration_sec,
    };
  }

  validatePost(input: PublishPostInput) {
    return validateTikTokPost(input);
  }

  async publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult> {
    const validation = this.validatePost(input);
    if (!validation.valid) {
      throw new Error(
        validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '),
      );
    }

    const options = tiktokPublishOptions(input.options);
    const caption = tiktokCaption(input);
    const video = input.media.find((item) => item.type === 'VIDEO');
    const images = input.media.filter((item) => item.type === 'IMAGE');

    let init;
    if (video) {
      if (!video.bytes?.length) throw new Error('TikTok cần bytes video từ storage để upload.');

      if (options.postMode === 'MEDIA_UPLOAD') {
        init = await this.client.uploadVideoToInbox({
          accessToken: ctx.accessToken,
          bytes: video.bytes,
          mimeType: video.mimeType,
        });
      } else {
        const creator = await this.client.queryCreatorInfo(ctx.accessToken);
        const privacyLevel = selectPrivacyLevel(
          creator.data.privacy_level_options,
          options.privacyLevel,
        );
        init = await this.client.directPostVideo({
          accessToken: ctx.accessToken,
          title: caption || undefined,
          bytes: video.bytes,
          mimeType: video.mimeType,
          privacyLevel,
          disableComment: options.disableComment || (creator.data.comment_disabled ?? false),
          disableDuet: options.disableDuet || (creator.data.duet_disabled ?? false),
          disableStitch: options.disableStitch || (creator.data.stitch_disabled ?? false),
          videoCoverTimestampMs: options.videoCoverTimestampMs,
          brandContentToggle: options.brandContentToggle,
          brandOrganicToggle: options.brandOrganicToggle,
          isAiGenerated: options.isAiGenerated,
        });
      }
    } else {
      const creator =
        options.postMode === 'DIRECT_POST'
          ? await this.client.queryCreatorInfo(ctx.accessToken)
          : null;
      const privacyLevel = creator
        ? selectPrivacyLevel(creator.data.privacy_level_options, options.privacyLevel)
        : undefined;
      init = await this.client.publishPhoto({
        accessToken: ctx.accessToken,
        postMode: options.postMode,
        title: input.title?.trim() || undefined,
        description: caption || input.description || undefined,
        photoUrls: images.map((image) => image.url),
        photoCoverIndex: options.photoCoverIndex,
        privacyLevel,
        disableComment:
          options.postMode === 'DIRECT_POST'
            ? options.disableComment || (creator?.data.comment_disabled ?? false)
            : undefined,
        autoAddMusic: options.autoAddMusic,
        brandContentToggle: options.brandContentToggle,
        brandOrganicToggle: options.brandOrganicToggle,
        isAiGenerated: options.isAiGenerated,
      });
    }

    return {
      externalPostId: init.data.publish_id,
      publishedAt: new Date(),
      pending: true,
    };
  }

  async getPublishPlatformState(
    ctx: AdapterContext,
    publishId: string,
  ): Promise<TikTokPublishPlatformState> {
    const status = await this.client.fetchPublishStatus(ctx.accessToken, publishId);
    return {
      publishId,
      status: status.data.status,
      failReason: status.data.fail_reason,
      publiclyAvailablePostIds: status.data.publicaly_available_post_id?.map(String),
      uploadedBytes: status.data.uploaded_bytes,
      refreshedAt: new Date().toISOString(),
    };
  }

  async getPosts(ctx: AdapterContext, params: SyncPostsParams = {}): Promise<ExternalPostPage> {
    const page = await this.client.listVideos({
      accessToken: ctx.accessToken,
      cursor: params.cursor ? Number(params.cursor) : undefined,
      limit: params.limit,
    });
    return {
      items: page.data.videos.map(mapTikTokVideo),
      nextCursor: page.data.has_more && page.data.cursor ? String(page.data.cursor) : undefined,
      hasMore: page.data.has_more,
    };
  }

  async getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics> {
    const response = await this.client.queryVideos(ctx.accessToken, [externalPostId]);
    const video = response.data.videos[0];
    if (!video) return emptyPostMetrics();

    const metrics = emptyPostMetrics('UNSUPPORTED');
    metrics.views = metricFromApi(video.view_count ?? 0);
    metrics.likes = metricFromApi(video.like_count ?? 0);
    metrics.comments = metricFromApi(video.comment_count ?? 0);
    metrics.shares = metricFromApi(video.share_count ?? 0);
    metrics.engagement = metricFromApi(
      (video.like_count ?? 0) + (video.comment_count ?? 0) + (video.share_count ?? 0),
    );
    metrics.engagementRate = computeEngagementRate(metrics);
    metrics.raw = {
      video,
      platformMetrics: tiktokVideoPlatformMetrics(video),
    };
    return metrics;
  }

  async cancelPublish(ctx: AdapterContext, publishId: string): Promise<void> {
    await this.client.cancelPublish(ctx.accessToken, publishId);
  }
}

function tiktokCaption(input: PublishPostInput): string {
  return [input.caption, input.hashtags?.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
}

function emptyTikTokAccountMetrics(): AccountMetrics {
  const blank = { value: null, source: 'NOT_SYNCED' as const };
  return {
    followers: { ...blank },
    followersGained: { ...blank },
    reach: { ...blank },
    impressions: { ...blank },
    profileViews: { ...blank },
  };
}

function tiktokVideoPlatformMetrics(video: {
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  duration?: number;
  width?: number;
  height?: number;
}): PlatformMetricMap {
  const metrics: PlatformMetricMap = {};
  addTikTokPlatformMetric(
    metrics,
    'view_count',
    'Views',
    video.view_count ?? null,
    'count',
    'Video',
  );
  addTikTokPlatformMetric(
    metrics,
    'like_count',
    'Likes',
    video.like_count ?? null,
    'count',
    'Engagement',
  );
  addTikTokPlatformMetric(
    metrics,
    'comment_count',
    'Comments',
    video.comment_count ?? null,
    'count',
    'Engagement',
  );
  addTikTokPlatformMetric(
    metrics,
    'share_count',
    'Shares',
    video.share_count ?? null,
    'count',
    'Engagement',
  );
  addTikTokPlatformMetric(
    metrics,
    'duration',
    'Duration',
    video.duration ?? null,
    'seconds',
    'Video',
  );
  addTikTokPlatformMetric(metrics, 'width', 'Width', video.width ?? null, 'count', 'Video');
  addTikTokPlatformMetric(metrics, 'height', 'Height', video.height ?? null, 'count', 'Video');
  return metrics;
}

function tiktokAccountPlatformMetrics(profile: {
  follower_count?: number;
  display_name?: string;
  username?: string;
}): PlatformMetricMap {
  const metrics: PlatformMetricMap = {};
  addTikTokPlatformMetric(
    metrics,
    'follower_count',
    'Followers',
    profile.follower_count ?? null,
    'count',
    'Profile',
  );
  addTikTokPlatformMetric(
    metrics,
    'display_name',
    'Display name',
    profile.display_name ?? null,
    'text',
    'Profile',
  );
  addTikTokPlatformMetric(
    metrics,
    'username',
    'Username',
    profile.username ?? null,
    'text',
    'Profile',
  );
  return metrics;
}

function addTikTokPlatformMetric(
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

function tiktokPublishOptions(options: Record<string, unknown> | undefined): {
  postMode: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  privacyLevel?: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  videoCoverTimestampMs?: number;
  photoCoverIndex?: number;
  autoAddMusic?: boolean;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  isAiGenerated?: boolean;
} {
  const timestamp = Number(options?.videoCoverTimestampMs);
  const photoCoverIndex = Number(options?.photoCoverIndex);
  return {
    postMode: options?.postMode === 'DIRECT_POST' ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
    privacyLevel: typeof options?.privacyLevel === 'string' ? options.privacyLevel : undefined,
    disableComment: options?.disableComment === true,
    disableDuet: options?.disableDuet === true,
    disableStitch: options?.disableStitch === true,
    videoCoverTimestampMs:
      Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp) : undefined,
    photoCoverIndex:
      Number.isFinite(photoCoverIndex) && photoCoverIndex >= 0
        ? Math.floor(photoCoverIndex)
        : undefined,
    autoAddMusic: options?.autoAddMusic === true,
    brandContentToggle: options?.brandContentToggle === true,
    brandOrganicToggle: options?.brandOrganicToggle === true,
    isAiGenerated: options?.isAiGenerated === true,
  };
}

function selectPrivacyLevel(options: string[], requested?: string): string {
  if (requested && options.includes(requested)) return requested;
  if (!requested) {
    throw new Error(
      'TikTok Direct Post cần người dùng chọn privacy từ creator info trước khi publish.',
    );
  }
  throw new Error('TikTok privacy đã chọn không nằm trong danh sách creator info hiện tại.');
}
