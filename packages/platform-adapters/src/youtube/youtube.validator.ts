import type { PublishPostInput, ValidationResult } from '../core/types';

const YOUTUBE_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
]);

export function validateYouTubePost(input: PublishPostInput): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const videos = input.media.filter((item) => item.type === 'VIDEO');
  const images = input.media.filter((item) => item.type === 'IMAGE');

  if (videos.length !== 1 || images.length > 0 || input.media.length !== 1) {
    issues.push({
      field: 'media',
      message: 'YouTube upload cần đúng 1 video, không kèm ảnh trong phiên bản hiện tại.',
    });
  }

  const video = videos[0];
  if (
    video &&
    !YOUTUBE_VIDEO_MIME_TYPES.has(video.mimeType) &&
    !video.mimeType.startsWith('video/')
  ) {
    issues.push({
      field: 'media.video',
      message: 'YouTube chỉ nhận media MIME type dạng video/* hoặc các định dạng video phổ biến.',
    });
  }

  if (video && !video.bytes?.length) {
    issues.push({
      field: 'media.video',
      message: 'YouTube cần bytes từ storage để upload video trực tiếp lên API.',
    });
  }

  if (!input.title?.trim()) {
    issues.push({ field: 'title', message: 'YouTube cần tiêu đề video.' });
  }

  return { valid: issues.length === 0, issues };
}
