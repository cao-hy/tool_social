import type { MediaAssetView, SocialAccountView } from './types';

export interface PostComposerValidationInput {
  title?: string;
  body?: string;
  linkUrl?: string;
  selectedAccounts: SocialAccountView[];
  mediaAssets: Pick<
    MediaAssetView,
    'type' | 'status' | 'readUrl' | 'thumbnailUrl' | 'width' | 'height'
  >[];
  platformOverrides?: Array<{
    socialAccountId: string;
    title?: string;
    caption?: string;
    linkUrl?: string;
    mediaAssets?: Pick<
      MediaAssetView,
      'type' | 'status' | 'readUrl' | 'thumbnailUrl' | 'width' | 'height'
    >[];
    options?: Record<string, unknown>;
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
    const thumbnailMode = override?.options?.thumbnailMode;

    if (thumbnailMode === 'MEDIA_ASSET' && !override?.options?.thumbnailMediaAssetId) {
      return `${prefix}cần chọn ảnh cover/thumbnail đã upload.`;
    }

    if (
      thumbnailMode === 'GENERATED' &&
      !resolvedMedia.some((asset) => asset.type === 'VIDEO' && asset.thumbnailUrl)
    ) {
      return `${prefix}thumbnail tự tạo từ video chưa sẵn sàng.`;
    }

    if (account.platform === 'FACEBOOK') {
      if (imageCount > 0 && videoCount > 0) {
        return `${prefix}adapter Facebook hiện hỗ trợ multi-photo hoặc 1 video riêng, chưa hỗ trợ mixed media trong cùng một bài.`;
      }

      if (videoCount > 1) {
        return `${prefix}chỉ hỗ trợ publish một video trong một bài ở phiên bản hiện tại.`;
      }
    }

    if (account.platform === 'INSTAGRAM') {
      if (imageCount === 0 && videoCount === 0) {
        return `${prefix}cần ít nhất 1 ảnh hoặc 1 video.`;
      }
      if (imageCount + videoCount > 10) {
        return `${prefix}chỉ hỗ trợ tối đa 10 ảnh/video.`;
      }
      for (const asset of resolvedMedia) {
        if (asset.type === 'IMAGE' && asset.width && asset.height) {
          const ratio = asset.width / asset.height;
          if (ratio < 0.79 || ratio > 1.92) {
            return `${prefix}chỉ hỗ trợ hình ảnh có tỷ lệ khung hình (width/height) từ 4:5 (0.8) đến 1.91:1. Có ảnh hiện tại đang ở tỷ lệ ${ratio.toFixed(2)}.`;
          }
        }
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
        return `${prefix}TikTok yêu cầu chọn một trong hai loại: 1 video, hoặc 1-35 ảnh photo post.`;
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

      if (override?.options?.postMode === 'DIRECT_POST') {
        if (!override.options.privacyLevel) {
          return `${prefix}Direct Post cần chọn privacy từ creator info TikTok.`;
        }

        if (override.options.consentConfirmed !== true) {
          return `${prefix}Direct Post cần xác nhận Music Usage Confirmation.`;
        }

        if (
          override.options.commercialContentEnabled === true &&
          override.options.brandContentToggle !== true &&
          override.options.brandOrganicToggle !== true
        ) {
          return `${prefix}commercial content cần chọn Your brand hoặc Branded content.`;
        }

        if (
          override.options.brandContentToggle === true &&
          override.options.privacyLevel === 'SELF_ONLY'
        ) {
          return `${prefix}branded content không được chọn privacy Only me.`;
        }
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
