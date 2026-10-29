import type { ExternalPost, PlatformComment, SocialAccountProfile, TokenSet } from '../core/types';
import type {
  YouTubeChannel,
  YouTubeCommentThread,
  YouTubePlaylistItem,
  YouTubeTokenResponse,
  YouTubeVideoResponse,
} from './youtube.schemas';

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

export function mapYouTubePlaylistItem(
  item: YouTubePlaylistItem,
  video?: YouTubeVideoResponse,
): ExternalPost {
  const snippet = item.snippet;
  const videoId = snippet?.resourceId?.videoId;
  const uploadedAt = snippet?.publishedAt ? new Date(snippet.publishedAt) : new Date();
  const publishAtStr = video?.status?.publishAt;
  const publishAtDate = publishAtStr ? new Date(publishAtStr) : undefined;
  const rawPrivacy = video?.status?.privacyStatus?.toLowerCase();
  const privacyStatus =
    rawPrivacy === 'public' || rawPrivacy === 'private' || rawPrivacy === 'unlisted'
      ? rawPrivacy
      : undefined;

  const isScheduled = Boolean(
    publishAtDate &&
    !Number.isNaN(publishAtDate.getTime()) &&
    (privacyStatus === 'private' || publishAtDate.getTime() > Date.now()),
  );

  const scheduledAt = isScheduled ? publishAtDate : undefined;
  const publishedAt =
    !isScheduled && publishAtDate && !Number.isNaN(publishAtDate.getTime())
      ? publishAtDate
      : uploadedAt;

  return {
    externalPostId: videoId ?? item.id,
    title: video?.snippet?.title ?? snippet?.title,
    caption: video?.snippet?.description ?? snippet?.description,
    permalink: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
    publishedAt,
    scheduledAt,
    privacyStatus,
    media: [
      {
        url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
        thumbnailUrl:
          snippet?.thumbnails?.maxres?.url ??
          snippet?.thumbnails?.high?.url ??
          snippet?.thumbnails?.medium?.url ??
          snippet?.thumbnails?.default?.url,
        type: 'VIDEO',
      },
    ],
    metrics: video?.statistics
      ? {
          views: video.statistics.viewCount ?? null,
          likes: video.statistics.likeCount ?? null,
          comments: video.statistics.commentCount ?? null,
        }
      : undefined,
    raw: video
      ? {
          ...item,
          status: video.status,
          statistics: video.statistics,
          processingDetails: video.processingDetails,
        }
      : item,
  };
}
