import { countGraphemes } from '@socialhub/shared';
import type { PublishPostInput, ValidationResult, ValidationIssue } from '../core/types';

export function validateInstagramPost(input: PublishPostInput): ValidationResult {
  const issues: ValidationIssue[] = [];

  const hasImage = input.media.some((m) => m.type === 'IMAGE');
  const hasVideo = input.media.some((m) => m.type === 'VIDEO');
  const requestedMediaType =
    typeof input.options?.mediaType === 'string' ? input.options.mediaType : undefined;
  const locationId =
    typeof input.options?.locationId === 'string' ? input.options.locationId.trim() : '';
  const usesReelsCover =
    Boolean(input.thumbnail) &&
    input.media.length === 1 &&
    input.media[0]?.type === 'VIDEO' &&
    (requestedMediaType === undefined || requestedMediaType === 'REELS');

  // Instagram bắt buộc phải có ít nhất 1 ảnh hoặc 1 video
  if (!hasImage && !hasVideo) {
    issues.push({
      field: 'media',
      message: 'Instagram bắt buộc phải có ít nhất 1 ảnh hoặc 1 video.',
    });
  }

  // Instagram cho phép tối đa 10 media trong một carousel
  if (input.media.length > 10) {
    issues.push({
      field: 'media',
      message: 'Instagram chỉ hỗ trợ tối đa 10 ảnh/video.',
      limit: 10,
    });
  }

  input.media.forEach((item, index) => {
    if (!/^https?:\/\//.test(item.url)) {
      issues.push({
        field: `media[${index}].url`,
        message:
          'Instagram Graph API cần media URL công khai để Meta tải được. Local MinIO/localhost hoặc storage key nội bộ không dùng được.',
      });
      return;
    }

    const host = safeHostname(item.url);
    if (
      host === 'localhost' ||
      host === 'minio' ||
      host === '127.0.0.1' ||
      host?.startsWith('10.') ||
      host?.startsWith('172.') ||
      host?.startsWith('192.168.')
    ) {
      issues.push({
        field: `media[${index}].url`,
        message:
          'Instagram cần URL media public ngoài internet. Hãy cấu hình S3_PUBLIC_BASE_URL trỏ tới domain media public.',
      });
    }

    if (item.type === 'IMAGE' && item.width && item.height) {
      const ratio = item.width / item.height;
      if (ratio < 0.79 || ratio > 1.92) {
        issues.push({
          field: `media[${index}]`,
          message: `Instagram chỉ hỗ trợ hình ảnh có tỷ lệ khung hình (width/height) từ 4:5 (0.8) đến 1.91:1. Ảnh hiện tại có tỷ lệ ${ratio.toFixed(2)}.`,
        });
      }
    }
  });

  if (usesReelsCover && input.thumbnail) {
    if (input.thumbnail.type !== 'IMAGE') {
      issues.push({
        field: 'thumbnail',
        message: 'Instagram cover phải là ảnh.',
      });
    }

    if (!/^https:\/\//.test(input.thumbnail.url)) {
      issues.push({
        field: 'thumbnail.url',
        message: 'Instagram Reels cover cần URL ảnh public HTTPS để Meta tải được.',
      });
    } else {
      const host = safeHostname(input.thumbnail.url);
      if (
        host === 'localhost' ||
        host === 'minio' ||
        host === '127.0.0.1' ||
        host?.startsWith('10.') ||
        host?.startsWith('172.') ||
        host?.startsWith('192.168.')
      ) {
        issues.push({
          field: 'thumbnail.url',
          message: 'Instagram Reels cover cần URL ảnh public ngoài internet.',
        });
      }
    }
  }

  // Caption giới hạn 2200 ký tự
  const fullCaption = [input.caption, input.hashtags?.map((t) => `#${t}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
  if (countGraphemes(fullCaption) > 2200) {
    issues.push({
      field: 'caption',
      message: 'Nội dung (bao gồm hashtag) vượt quá 2200 ký tự.',
      limit: 2200,
    });
  }

  if (locationId) {
    if (!/^\d+$/.test(locationId)) {
      issues.push({
        field: 'options.locationId',
        message: 'Instagram location_id phải là Facebook Page/Place ID dạng số.',
      });
    }

    if (requestedMediaType === 'REELS' || requestedMediaType === 'STORY') {
      issues.push({
        field: 'options.locationId',
        message:
          'Instagram location_id chỉ áp dụng cho Feed/Carousel trong luồng publish hiện tại.',
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
