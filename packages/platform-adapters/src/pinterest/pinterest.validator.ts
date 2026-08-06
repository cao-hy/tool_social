import { countGraphemes } from '@socialhub/shared';
import type { PublishPostInput, ValidationIssue, ValidationResult } from '../core/types';

const PINTEREST_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const PINTEREST_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v']);

export function validatePinterestPost(input: PublishPostInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const images = input.media.filter((item) => item.type === 'IMAGE');
  const videos = input.media.filter((item) => item.type === 'VIDEO');
  const isImagePin = images.length === 1 && videos.length === 0 && input.media.length === 1;
  const isVideoPin = videos.length === 1 && images.length <= 1 && input.media.length <= 2;

  if (!isImagePin && !isVideoPin) {
    issues.push({
      field: 'media',
      message:
        'Pinterest hiện hỗ trợ 1 ảnh, hoặc 1 video kèm tối đa 1 ảnh cover public cho mỗi Pin.',
    });
  }

  const image = images[0];
  if (image && !PINTEREST_IMAGE_MIME_TYPES.has(image.mimeType)) {
    issues.push({
      field: 'media[0].mimeType',
      message: 'Pinterest image Pin hiện chỉ nhận JPEG hoặc PNG trong adapter này.',
    });
  }

  if (image && !image.bytes?.length && !/^https?:\/\//.test(image.url)) {
    issues.push({
      field: 'media[0]',
      message: 'Pinterest cần ảnh dạng bytes từ storage hoặc URL ảnh công khai.',
    });
  }

  const video = videos[0];
  if (video && !PINTEREST_VIDEO_MIME_TYPES.has(video.mimeType)) {
    issues.push({
      field: 'media.video.mimeType',
      message: 'Pinterest video Pin hiện chỉ nhận MP4, MOV hoặc M4V trong adapter này.',
    });
  }

  if (video && !video.bytes?.length) {
    issues.push({
      field: 'media.video',
      message: 'Pinterest video cần bytes từ storage để upload lên Pinterest media bucket.',
    });
  }

  if (video) {
    const cover = input.thumbnail ?? image;
    const hasPublicUrl = cover?.url && /^https?:\/\//.test(cover.url);
    const hasBytes = cover?.bytes && cover.bytes.length > 0;
    if (!hasPublicUrl && !hasBytes) {
      issues.push({
        field: 'thumbnail',
        message:
          'Pinterest video cần cover image URL public hoặc dữ liệu ảnh. Hãy gắn thêm 1 ảnh cover.',
      });
    }
  }

  if (countGraphemes(input.title ?? '') > 100) {
    issues.push({
      field: 'title',
      message: 'Pinterest title tối đa 100 ký tự.',
      limit: 100,
    });
  }

  const description = pinterestDescription(input);
  if (countGraphemes(description) > 800) {
    issues.push({
      field: 'description',
      message: 'Pinterest description tối đa 800 ký tự.',
      limit: 800,
    });
  }

  if (input.linkUrl && !isValidHttpUrl(input.linkUrl)) {
    issues.push({
      field: 'linkUrl',
      message: 'Pinterest link phải là URL http:// hoặc https:// hợp lệ.',
    });
  }

  return { valid: issues.length === 0, issues };
}

export function pinterestDescription(input: PublishPostInput): string {
  return [input.description ?? input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
