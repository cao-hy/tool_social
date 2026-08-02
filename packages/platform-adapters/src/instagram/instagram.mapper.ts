import type { ExternalPost, SocialAccountProfile, TokenSet } from '../core/types';
import type {
  InstagramMedia,
  InstagramPage,
  InstagramProfile,
  InstagramTokenResponse,
} from './instagram.schemas';

export function selectInstagramAccount(pages: InstagramPage[]): {
  page: InstagramPage;
  igAccountId: string;
} {
  // Ưu tiên page có instagram_business_account
  const pageWithIg = pages.find((p) => p.instagram_business_account?.id);
  if (!pageWithIg || !pageWithIg.instagram_business_account) {
    throw new Error(
      'Không tìm thấy tài khoản Instagram Business nào được liên kết với các Facebook Page bạn quản lý.',
    );
  }
  return { page: pageWithIg, igAccountId: pageWithIg.instagram_business_account.id };
}

export function mapInstagramToken(input: {
  page: InstagramPage;
  igAccountId: string;
  profile: InstagramProfile;
  userToken: InstagramTokenResponse;
  scopes: string[];
}): TokenSet {
  return {
    accessToken: input.page.access_token,
    accessTokenExpiresAt: input.userToken.expires_in
      ? new Date(Date.now() + input.userToken.expires_in * 1000)
      : undefined,
    scopes: input.scopes,
    tokenType: input.userToken.token_type ?? 'bearer',
    accountProfile: mapInstagramProfile(input.profile),
  };
}

export function mapInstagramProfile(profile: InstagramProfile): SocialAccountProfile {
  return {
    externalAccountId: profile.id,
    name: profile.name || profile.username,
    username: profile.username,
    avatarUrl: profile.profile_picture_url,
    profileUrl: `https://www.instagram.com/${profile.username}`,
    followersCount: profile.followers_count,
  };
}

export function mapInstagramMedia(media: InstagramMedia): ExternalPost {
  return {
    externalPostId: media.id,
    title: undefined,
    caption: media.caption,
    permalink: media.permalink,
    publishedAt: media.timestamp ? new Date(media.timestamp) : new Date(),
    updatedAt: undefined,
    media: [
      {
        url: media.media_url ?? '',
        thumbnailUrl: media.thumbnail_url ?? media.media_url ?? '',
        type: media.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGE',
      },
    ],
    metrics: {
      likes: media.like_count ?? null,
      comments: media.comments_count ?? null,
      shares: null,
    },
    raw: media,
  };
}
