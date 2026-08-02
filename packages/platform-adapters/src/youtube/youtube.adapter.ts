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
  PlatformComment,
  PlatformPostData,
  PostMetrics,
  EditPostInput,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  SyncCommentsParams,
  TokenSet,
} from '../core/types';
import {
  mapYouTubeChannelProfile,
  mapYouTubeCommentThread,
  mapYouTubeToken,
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

  async getPosts(): Promise<Paginated<PlatformPostData>> {
    throw capabilityUnsupported('YOUTUBE', 'getPosts');
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
    const metrics = emptyPostMetrics('UNSUPPORTED');
    if (video.statistics?.viewCount !== undefined) {
      metrics.views = metricFromApi(video.statistics.viewCount);
    }
    if (video.statistics?.likeCount !== undefined) {
      metrics.likes = metricFromApi(video.statistics.likeCount);
    }
    if (video.statistics?.commentCount !== undefined) {
      metrics.comments = metricFromApi(video.statistics.commentCount);
    }
    const engagement = (video.statistics?.likeCount ?? 0) + (video.statistics?.commentCount ?? 0);
    if (video.statistics?.likeCount !== undefined || video.statistics?.commentCount !== undefined) {
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
