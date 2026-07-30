import type { PublishPostInput, ValidationResult } from '../core/types';

const TIKTOK_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const TIKTOK_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function validateTikTokPost(input: PublishPostInput): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const videos = input.media.filter((item) => item.type === 'VIDEO');
  const images = input.media.filter((item) => item.type === 'IMAGE');
  const postMode = tiktokPostMode(input.options);

  if (videos.length === 0 && images.length === 0) {
    issues.push({
      field: 'media',
      message: 'TikTok cần 1 video hoặc 1-35 ảnh.',
    });
  }

  if (videos.length > 0 && (videos.length !== 1 || images.length > 0 || input.media.length !== 1)) {
    issues.push({
      field: 'media',
      message: 'TikTok video post hiện hỗ trợ đúng 1 video, không kèm ảnh.',
    });
  }

  if (images.length > 35) {
    issues.push({
      field: 'media',
      message: 'TikTok photo post tối đa 35 ảnh.',
      limit: 35,
    });
  }

  const video = videos[0];
  if (video) {
    if (!TIKTOK_VIDEO_MIME_TYPES.has(video.mimeType)) {
      issues.push({
        field: 'media.video',
        message: 'TikTok Content Posting API nhận video/mp4, video/quicktime hoặc video/webm.',
      });
    }

    if (!video.bytes?.length) {
      issues.push({
        field: 'media.video',
        message: 'TikTok cần bytes từ storage để upload video trực tiếp.',
      });
    }
  }

  if (images.length > 0 && videos.length === 0) {
    for (const image of images) {
      if (!TIKTOK_IMAGE_MIME_TYPES.has(image.mimeType)) {
        issues.push({
          field: 'media.image',
          message: 'TikTok photo post nhận JPEG, PNG, WebP, HEIC hoặc HEIF.',
        });
        break;
      }

      if (!isPublicHttpsUrl(image.url)) {
        issues.push({
          field: 'media.image',
          message:
            'TikTok photo post cần URL ảnh HTTPS public và domain/prefix đã verify trong TikTok Developer Portal.',
        });
        break;
      }
    }

    if (postMode === 'DIRECT_POST' && !input.options?.privacyLevel) {
      issues.push({
        field: 'options.privacyLevel',
        message: 'TikTok Direct Photo Post cần privacy level hợp lệ.',
      });
    }
  }

  const caption = [input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
  if (caption.length > 2200) {
    issues.push({ field: 'caption', message: 'TikTok caption tối đa 2200 ký tự.', limit: 2200 });
  }

  return { valid: issues.length === 0, issues };
}

function tiktokPostMode(
  options: Record<string, unknown> | undefined,
): 'DIRECT_POST' | 'MEDIA_UPLOAD' {
  return options?.postMode === 'MEDIA_UPLOAD' ? 'MEDIA_UPLOAD' : 'DIRECT_POST';
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', 'minio'].includes(url.hostname);
  } catch {
    return false;
  }
}
