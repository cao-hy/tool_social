import type { PlatformComment, SocialAccountProfile, TokenSet } from '../core/types';
import type { YouTubeChannel, YouTubeCommentThread, YouTubeTokenResponse } from './youtube.schemas';

export function mapYouTubeToken(input: {
  token: YouTubeTokenResponse;
  scopes: string[];
  channel: YouTubeChannel;
}): TokenSet {
  return {
    accessToken: input.token.access_token,
    refreshToken: input.token.refresh_token,
    accessTokenExpiresAt: input.token.expires_in
      ? new Date(Date.now() + input.token.expires_in * 1000)
      : undefined,
    scopes: input.token.scope?.split(/\s+/).filter(Boolean) ?? input.scopes,
    tokenType: input.token.token_type ?? 'Bearer',
    accountProfile: mapYouTubeChannelProfile(input.channel),
  };
}

export function mapYouTubeChannelProfile(channel: YouTubeChannel): SocialAccountProfile {
  const thumbnail = channel.snippet?.thumbnails;
  const avatarUrl =
    thumbnail?.high?.url ?? thumbnail?.medium?.url ?? thumbnail?.default?.url ?? undefined;
  const customUrl = channel.snippet?.customUrl;

  return {
    externalAccountId: channel.id,
    name: channel.snippet?.title ?? channel.id,
    username: customUrl,
    avatarUrl,
    profileUrl: customUrl
      ? `https://www.youtube.com/${customUrl.startsWith('@') ? customUrl : `@${customUrl}`}`
      : `https://www.youtube.com/channel/${channel.id}`,
    followersCount: channel.statistics?.hiddenSubscriberCount
      ? undefined
      : channel.statistics?.subscriberCount,
  };
}

export function mapYouTubeCommentThread(input: {
  thread: YouTubeCommentThread;
  externalPostId: string;
  externalAccountId: string;
}): PlatformComment[] {
  const topLevel = input.thread.snippet.topLevelComment;
  const comments = [
    mapYouTubeComment({
      comment: topLevel,
      externalPostId: input.thread.snippet.videoId ?? input.externalPostId,
      externalAccountId: input.externalAccountId,
    }),
  ];

  for (const reply of input.thread.replies?.comments ?? []) {
    comments.push(
      mapYouTubeComment({
        comment: reply,
        externalPostId: input.thread.snippet.videoId ?? input.externalPostId,
        externalAccountId: input.externalAccountId,
        parentExternalCommentId: reply.snippet.parentId ?? topLevel.id,
      }),
    );
  }

  return comments;
}

function mapYouTubeComment(input: {
  comment: YouTubeCommentThread['snippet']['topLevelComment'];
  externalPostId: string;
  externalAccountId: string;
  parentExternalCommentId?: string;
}): PlatformComment {
  const authorExternalId = input.comment.snippet.authorChannelId?.value;

  return {
    externalCommentId: input.comment.id,
    externalPostId: input.externalPostId,
    parentExternalCommentId: input.parentExternalCommentId ?? input.comment.snippet.parentId,
    authorExternalId,
    authorName: input.comment.snippet.authorDisplayName,
    authorAvatarUrl: input.comment.snippet.authorProfileImageUrl,
    message: input.comment.snippet.textOriginal ?? input.comment.snippet.textDisplay,
    likeCount: input.comment.snippet.likeCount,
    postedAt: new Date(input.comment.snippet.publishedAt),
    isFromOwner: authorExternalId === input.externalAccountId,
  };
}
