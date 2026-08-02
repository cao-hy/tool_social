import { createPlatformError } from '../core/platform-error';
import type {
  ExternalPost,
  ExternalPostMedia,
  PlatformComment,
  SocialAccountProfile,
  TokenSet,
} from '../core/types';
import type {
  FacebookComment,
  FacebookPage,
  FacebookPageProfile,
  FacebookPagePostsResponse,
  FacebookTokenResponse,
} from './facebook.schemas';

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

export function mapFacebookComment(input: {
  comment: FacebookComment;
  externalPostId: string;
  externalPageId: string;
}): PlatformComment {
  return {
    externalCommentId: input.comment.id,
    externalPostId: input.externalPostId,
    parentExternalCommentId: input.comment.parent?.id,
    authorExternalId: input.comment.from?.id,
    authorName: input.comment.from?.name,
    authorAvatarUrl: input.comment.from?.picture?.data?.url,
    message: input.comment.message,
    likeCount: input.comment.like_count,
    postedAt: new Date(input.comment.created_time),
    isHidden: input.comment.is_hidden,
    isFromOwner: input.comment.from?.id === input.externalPageId,
  };
}

export function mapFacebookPagePost(post: FacebookPagePostsResponse['data'][0]): ExternalPost {
  const mediaList: ExternalPostMedia[] = [];

  const mainAttachment = post.attachments?.data?.[0];
  if (mainAttachment) {
    if (mainAttachment.subattachments?.data) {
      for (const sub of mainAttachment.subattachments.data) {
        if (sub.media?.image?.src) {
          mediaList.push({
            url: sub.media.source ?? sub.media.image.src,
            thumbnailUrl: sub.media.image.src,
            type: sub.type?.includes('video') ? 'VIDEO' : 'IMAGE',
          });
        }
      }
    } else if (mainAttachment.media?.image?.src) {
      mediaList.push({
        url: mainAttachment.media.source ?? mainAttachment.media.image.src,
        thumbnailUrl: mainAttachment.media.image.src,
        type: mainAttachment.type?.includes('video') ? 'VIDEO' : 'IMAGE',
      });
    }
  }

  return {
    externalPostId: post.id,
    title: mainAttachment?.title,
    caption: post.message ?? mainAttachment?.description,
    permalink: post.permalink_url,
    publishedAt: new Date(post.created_time),
    updatedAt: post.updated_time ? new Date(post.updated_time) : undefined,
    media: mediaList,
    metrics: {
      likes: post.likes?.summary?.total_count ?? null,
      comments: post.comments?.summary?.total_count ?? null,
      shares: post.shares?.count ?? null,
    },
    raw: post,
  };
}
