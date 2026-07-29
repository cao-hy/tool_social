import type { PublishPostInput, ValidationResult } from '../core/types';

const TIKTOK_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export function validateTikTokPost(input: PublishPostInput): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const videos = input.media.filter((item) => item.type === 'VIDEO');
  const images = input.media.filter((item) => item.type === 'IMAGE');

  if (videos.length !== 1 || images.length > 0 || input.media.length !== 1) {
    issues.push({
      field: 'media',
      message: 'TikTok Direct Post hiện hỗ trợ đúng 1 video cho mỗi bài đăng.',
    });
  }

  const video = videos[0];
  if (video && !TIKTOK_VIDEO_MIME_TYPES.has(video.mimeType)) {
    issues.push({
      field: 'media.video',
      message: 'TikTok Content Posting API nhận video/mp4, video/quicktime hoặc video/webm.',
    });
  }

  if (video && !video.bytes?.length) {
    issues.push({
      field: 'media.video',
      message: 'TikTok cần bytes từ storage để upload video trực tiếp.',
    });
  }

  const caption = [input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
  if (caption.length > 2200) {
    issues.push({ field: 'caption', message: 'TikTok caption tối đa 2200 ký tự.', limit: 2200 });
  }

  return { valid: issues.length === 0, issues };
}
