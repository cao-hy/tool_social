import type { SocialAccountProfile, TokenSet } from '../core/types';
import type {
  PinterestBoard,
  PinterestTokenResponse,
  PinterestUserAccount,
} from './pinterest.schemas';

export function mapPinterestToken(input: {
  token: PinterestTokenResponse;
  scopes: string[];
  account: PinterestUserAccount;
  board: PinterestBoard;
}): TokenSet {
  const accessTokenExpiresAt = input.token.expires_in
    ? new Date(Date.now() + input.token.expires_in * 1000)
    : undefined;
  const refreshTokenExpiresAt = input.token.refresh_token_expires_at
    ? new Date(input.token.refresh_token_expires_at * 1000)
    : undefined;

  return {
    accessToken: input.token.access_token,
    refreshToken: input.token.refresh_token,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    scopes: input.token.scope?.split(/[,\s]+/).filter(Boolean) ?? input.scopes,
    tokenType: input.token.token_type ?? 'bearer',
    accountProfile: mapPinterestProfile(input.account, input.board),
  };
}

export function mapPinterestProfile(
  account: PinterestUserAccount,
  board?: PinterestBoard,
): SocialAccountProfile {
  const username = account.username ?? account.id ?? 'pinterest';
  const displayName = account.business_name ?? username;

  return {
    externalAccountId: account.id ?? username,
    externalPageId: board?.id,
    name: board ? `${displayName} / ${board.name}` : displayName,
    username,
    avatarUrl: account.profile_image,
    profileUrl: account.username ? `https://www.pinterest.com/${account.username}/` : undefined,
    followersCount: account.follower_count,
  };
}
