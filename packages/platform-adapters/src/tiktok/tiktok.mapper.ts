import type { ExternalPost, SocialAccountProfile, TokenSet } from '../core/types';
import type {
  TikTokTokenResponse,
  TikTokUserInfoResponse,
  TikTokVideoListResponse,
} from './tiktok.schemas';

export function mapTikTokToken(input: {
  token: TikTokTokenResponse;
  scopes: string[];
  profile: TikTokUserInfoResponse['data']['user'];
}): TokenSet {
  return {
    accessToken: input.token.access_token,
    refreshToken: input.token.refresh_token,
    accessTokenExpiresAt: input.token.expires_in
      ? new Date(Date.now() + input.token.expires_in * 1000)
      : undefined,
    refreshTokenExpiresAt: input.token.refresh_expires_in
      ? new Date(Date.now() + input.token.refresh_expires_in * 1000)
      : undefined,
    scopes:
      input.token.scope
        ?.split(',')
        .map((scope) => scope.trim())
        .filter(Boolean) ?? input.scopes,
    tokenType: input.token.token_type ?? 'Bearer',
    accountProfile: mapTikTokProfile(input.profile),
  };
}

export function mapTikTokProfile(
  profile: TikTokUserInfoResponse['data']['user'],
): SocialAccountProfile {
  return {
    externalAccountId: profile.open_id,
    name: profile.display_name ?? profile.username ?? profile.open_id,
    username: profile.username,
    avatarUrl: profile.avatar_large_url ?? profile.avatar_url_100 ?? profile.avatar_url,
    profileUrl: profile.profile_deep_link,
    followersCount: profile.follower_count,
  };
}

export function mapTikTokVideo(video: TikTokVideoListResponse['data']['videos'][0]): ExternalPost {
  return {
    externalPostId: video.id,
    title: video.title,
    caption: video.video_description ?? video.title,
    permalink: video.share_url,
    publishedAt: video.create_time ? new Date(video.create_time * 1000) : new Date(),
    media: [
      {
        url: video.share_url ?? '',
        thumbnailUrl: video.cover_image_url ?? '',
        type: 'VIDEO',
        duration: video.duration,
        width: video.width,
        height: video.height,
      },
    ],
    metrics: {
      views: video.view_count ?? null,
      likes: video.like_count ?? null,
      comments: video.comment_count ?? null,
      shares: video.share_count ?? null,
    },
    raw: video,
  };
}
