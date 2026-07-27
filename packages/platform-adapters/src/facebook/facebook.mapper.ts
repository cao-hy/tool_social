import { createPlatformError } from '../core/platform-error';
import type { SocialAccountProfile, TokenSet } from '../core/types';
import type { FacebookPage, FacebookPageProfile, FacebookTokenResponse } from './facebook.schemas';

export function selectFacebookPage(pages: FacebookPage[]): FacebookPage {
  const page = pages.find((item) => item.access_token);
  if (!page) {
    throw createPlatformError(
      'PERMISSION_DENIED',
      'FACEBOOK',
      'Facebook không trả về Page access token. Hãy kiểm tra Page bạn quản lý và scope pages_show_list/pages_read_engagement.',
      {},
    );
  }
  return page;
}

export function mapFacebookPageToken(input: {
  page: FacebookPage;
  userToken: FacebookTokenResponse;
  scopes: string[];
}): TokenSet {
  return {
    accessToken: input.page.access_token,
    scopes: input.scopes,
    tokenType: input.userToken.token_type ?? 'Bearer',
    accountProfile: {
      externalAccountId: input.page.id,
      name: input.page.name,
      username: input.page.username,
      avatarUrl: input.page.picture?.data?.url,
      profileUrl: input.page.link,
    },
  };
}

export function mapFacebookPageProfile(profile: FacebookPageProfile): SocialAccountProfile {
  return {
    externalAccountId: profile.id,
    name: profile.name,
    username: profile.username,
    avatarUrl: profile.picture?.data?.url,
    profileUrl: profile.link,
    followersCount: profile.fan_count,
  };
}
