import type { MediaAssetView, SocialAccountView } from './types';

export interface PostComposerValidationInput {
  title?: string;
  body?: string;
  linkUrl?: string;
  selectedAccounts: SocialAccountView[];
  mediaAssets: Pick<MediaAssetView, 'type' | 'status'>[];
  requireTargets: boolean;
  requirePublishableContent: boolean;
}

export function validatePostComposer(input: PostComposerValidationInput): string | null {
  const hasText = Boolean(input.body?.trim() || input.title?.trim());
  const hasLink = Boolean(input.linkUrl?.trim());
  const hasMedia = input.mediaAssets.length > 0;

  if (input.requireTargets && input.selectedAccounts.length === 0) {
    return 'Cần chọn ít nhất một social account.';
  }

  if (hasLink && !isValidHttpUrl(input.linkUrl?.trim() ?? '')) {
    return 'Link phải là URL hợp lệ và bắt đầu bằng http:// hoặc https://.';
  }

  if (input.mediaAssets.some((asset) => asset.status !== 'READY')) {
    return 'Media chưa xử lý xong. Hãy chờ upload hoàn tất rồi thử lại.';
  }

  if (input.requirePublishableContent && !hasText && !hasLink && !hasMedia) {
    return 'Bài publish cần có nội dung chữ, link hoặc media.';
  }

  const includesFacebook = input.selectedAccounts.some(
    (account) => account.platform === 'FACEBOOK',
  );
  if (includesFacebook) {
    const imageCount = input.mediaAssets.filter((asset) => asset.type === 'IMAGE').length;
    const videoCount = input.mediaAssets.filter((asset) => asset.type === 'VIDEO').length;

    if (imageCount > 0 && videoCount > 0) {
      return 'Facebook chưa hỗ trợ trộn ảnh và video trong cùng một bài publish.';
    }

    if (videoCount > 1) {
      return 'Facebook chỉ hỗ trợ publish một video trong một bài ở phiên bản hiện tại.';
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
