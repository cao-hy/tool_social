import { emptyPostMetrics, type Paginated } from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import { capabilityUnsupported } from '../core/platform-error';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  PlatformPostData,
  PostMetrics,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  TokenSet,
} from '../core/types';
import { TikTokClient, type TikTokClientConfig } from './tiktok.client';
import { mapTikTokProfile, mapTikTokToken } from './tiktok.mapper';
import { validateTikTokPost } from './tiktok.validator';

export interface TikTokAdapterConfig extends TikTokClientConfig {
  scopes?: string[];
}

export const TIKTOK_OAUTH_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'] as const;

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

    const video = input.media.find((item) => item.type === 'VIDEO');
    if (!video?.bytes?.length) throw new Error('TikTok cần bytes video từ storage để upload.');

    const creator = await this.client.queryCreatorInfo(ctx.accessToken);
    const options = tiktokPublishOptions(input.options);
    const privacyLevel = selectPrivacyLevel(
      creator.data.privacy_level_options,
      options.privacyLevel,
    );
    const caption = tiktokCaption(input);
    const init = await this.client.directPostVideo({
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

  async getPosts(): Promise<Paginated<PlatformPostData>> {
    throw capabilityUnsupported('TIKTOK', 'getPosts');
  }

  async getPostMetrics(_ctx: AdapterContext, _externalPostId: string): Promise<PostMetrics> {
    return emptyPostMetrics();
  }
}

function tiktokCaption(input: PublishPostInput): string {
  return [input.caption, input.hashtags?.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
}

function tiktokPublishOptions(options: Record<string, unknown> | undefined): {
  privacyLevel?: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  videoCoverTimestampMs?: number;
} {
  const timestamp = Number(options?.videoCoverTimestampMs);
  return {
    privacyLevel: typeof options?.privacyLevel === 'string' ? options.privacyLevel : undefined,
    disableComment: options?.disableComment === true,
    disableDuet: options?.disableDuet === true,
    disableStitch: options?.disableStitch === true,
    videoCoverTimestampMs:
      Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp) : undefined,
  };
}

function selectPrivacyLevel(options: string[], requested?: string): string {
  if (requested && options.includes(requested)) return requested;
  if (options.includes('PUBLIC_TO_EVERYONE')) return 'PUBLIC_TO_EVERYONE';
  if (options.includes('MUTUAL_FOLLOW_FRIENDS')) return 'MUTUAL_FOLLOW_FRIENDS';
  if (options.includes('FOLLOWER_OF_CREATOR')) return 'FOLLOWER_OF_CREATOR';
  return options[0] ?? 'SELF_ONLY';
}
