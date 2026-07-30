import type { MediaAssetView, SocialAccountView } from './types';

export interface PostComposerValidationInput {
  title?: string;
  body?: string;
  linkUrl?: string;
  selectedAccounts: SocialAccountView[];
  mediaAssets: Pick<MediaAssetView, 'type' | 'status' | 'readUrl'>[];
  platformOverrides?: Array<{
    socialAccountId: string;
    title?: string;
    caption?: string;
    linkUrl?: string;
    mediaAssets?: Pick<MediaAssetView, 'type' | 'status' | 'readUrl'>[];
  }>;
  requireTargets: boolean;
  requirePublishableContent: boolean;
}

export function validatePostComposer(input: PostComposerValidationInput): string | null {
  if (input.requireTargets && input.selectedAccounts.length === 0) {
    return 'Cần chọn ít nhất một social account.';
  }

  const hasCommonLink = Boolean(input.linkUrl?.trim());

  if (hasCommonLink && !isValidHttpUrl(input.linkUrl?.trim() ?? '')) {
    return 'Link phải là URL hợp lệ và bắt đầu bằng http:// hoặc https://.';
  }

  if (input.mediaAssets.some((asset) => asset.status !== 'READY')) {
    return 'Media chưa xử lý xong. Hãy chờ upload hoàn tất rồi thử lại.';
  }

  for (const account of input.selectedAccounts) {
    const override = input.platformOverrides?.find((item) => item.socialAccountId === account.id);
    const resolvedTitle = override?.title ?? input.title;
    const resolvedBody = override?.caption ?? input.body;
    const resolvedLink = override?.linkUrl ?? input.linkUrl;
    const resolvedMedia = override?.mediaAssets ?? input.mediaAssets;
    const prefix = `${account.name} (${account.platform}): `;

    if (resolvedLink?.trim() && !isValidHttpUrl(resolvedLink.trim())) {
      return `${prefix}link phải là URL hợp lệ và bắt đầu bằng http:// hoặc https://.`;
    }

    if (resolvedMedia.some((asset) => asset.status !== 'READY')) {
      return `${prefix}media chưa xử lý xong.`;
    }

    if (
      input.requirePublishableContent &&
      !resolvedTitle?.trim() &&
      !resolvedBody?.trim() &&
      !resolvedLink?.trim() &&
      resolvedMedia.length === 0
    ) {
      return `${prefix}cần có nội dung chữ, link hoặc media.`;
    }

    const imageCount = resolvedMedia.filter((asset) => asset.type === 'IMAGE').length;
    const videoCount = resolvedMedia.filter((asset) => asset.type === 'VIDEO').length;

    if (account.platform === 'FACEBOOK') {
      if (imageCount > 0 && videoCount > 0) {
        return `${prefix}chưa hỗ trợ trộn ảnh và video trong cùng một bài publish.`;
      }

      if (videoCount > 1) {
        return `${prefix}chỉ hỗ trợ publish một video trong một bài ở phiên bản hiện tại.`;
      }
    }

    if (account.platform === 'PINTEREST') {
      const isImagePin = imageCount === 1 && videoCount === 0 && resolvedMedia.length === 1;
      const isVideoPin = videoCount === 1 && imageCount <= 1 && resolvedMedia.length <= 2;

      if (!isImagePin && !isVideoPin) {
        return `${prefix}hiện hỗ trợ 1 ảnh, hoặc 1 video kèm tối đa 1 ảnh cover cho mỗi Pin.`;
      }
    }

    if (account.platform === 'YOUTUBE') {
      if (!resolvedTitle?.trim()) {
        return `${prefix}cần tiêu đề video.`;
      }

      if (videoCount !== 1 || imageCount > 0 || resolvedMedia.length !== 1) {
        return `${prefix}hiện hỗ trợ đúng 1 video cho mỗi bài đăng, không kèm ảnh.`;
      }
    }

    if (account.platform === 'TIKTOK') {
      if (videoCount > 0 && (videoCount !== 1 || imageCount > 0 || resolvedMedia.length !== 1)) {
        return `${prefix}video post hiện hỗ trợ đúng 1 video, không kèm ảnh.`;
      }

      if (imageCount > 0 && videoCount > 0) {
        return `${prefix}không trộn ảnh và video trong cùng một TikTok post.`;
      }

      if (imageCount > 35) {
        return `${prefix}photo post tối đa 35 ảnh.`;
      }

      if (imageCount > 0 && resolvedMedia.some((asset) => !asset.readUrl?.startsWith('https://'))) {
        return `${prefix}photo post cần URL ảnh HTTPS public đã verify trong TikTok Developer Portal.`;
      }

      if (videoCount === 0 && imageCount === 0) {
        return `${prefix}cần 1 video hoặc 1-35 ảnh.`;
      }
    }
  }

  return null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
