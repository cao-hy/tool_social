import {
  computeEngagementRate,
  emptyPostMetrics,
  metricFromApi,
  type Paginated,
} from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  PlatformPostData,
  PostMetrics,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  SyncPostsParams,
  TokenSet,
} from '../core/types';
import { TikTokClient, type TikTokClientConfig } from './tiktok.client';
import { mapTikTokProfile, mapTikTokToken } from './tiktok.mapper';
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

  async getPosts(
    ctx: AdapterContext,
    params: SyncPostsParams = {},
  ): Promise<Paginated<PlatformPostData>> {
    const page = await this.client.listVideos({
      accessToken: ctx.accessToken,
      cursor: params.cursor ? Number(params.cursor) : undefined,
      limit: params.limit,
    });
    return {
      items: page.data.videos.map((video) => ({
        externalPostId: video.id,
        externalUrl: video.share_url,
        caption: video.video_description ?? video.title,
        title: video.title,
        mediaType: 'VIDEO',
        thumbnailUrl: video.cover_image_url,
        publishedAt: video.create_time ? new Date(video.create_time * 1000) : new Date(0),
      })),
      nextCursor: page.data.has_more && page.data.cursor ? String(page.data.cursor) : null,
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
  };
}

function selectPrivacyLevel(options: string[], requested?: string): string {
  if (requested && options.includes(requested)) return requested;
  if (options.includes('PUBLIC_TO_EVERYONE')) return 'PUBLIC_TO_EVERYONE';
  if (options.includes('MUTUAL_FOLLOW_FRIENDS')) return 'MUTUAL_FOLLOW_FRIENDS';
  if (options.includes('FOLLOWER_OF_CREATOR')) return 'FOLLOWER_OF_CREATOR';
  return options[0] ?? 'SELF_ONLY';
}
