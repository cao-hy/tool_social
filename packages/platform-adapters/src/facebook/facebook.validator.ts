import type { PublishPostInput, ValidationIssue, ValidationResult } from '../core/types';

export function validateFacebookPost(input: PublishPostInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const hasCaption = Boolean(input.caption?.trim());
  const hasMedia = input.media.length > 0;
  const hasLink = Boolean(input.linkUrl?.trim());
  const images = input.media.filter((item) => item.type === 'IMAGE');
  const videos = input.media.filter((item) => item.type === 'VIDEO');

  if (images.length > 0 && videos.length > 0) {
    issues.push({
      field: 'media',
      message: 'Facebook không hỗ trợ trộn ảnh và video trong cùng một bài publish của hệ thống.',
    });
  }

  if (videos.length > 1) {
    issues.push({
      field: 'media',
      message: 'Facebook chỉ hỗ trợ publish một video trong một bài ở phiên bản hiện tại.',
      limit: 1,
    });
  }

  input.media.forEach((item, index) => {
    if (!item.bytes || item.bytes.byteLength === 0) {
      issues.push({
        field: `media[${index}]`,
        message: 'Media chưa có dữ liệu binary để upload sang Facebook.',
      });
    }
  });

  if (!hasCaption && !hasMedia && !hasLink) {
    issues.push({
      field: 'caption',
      message: 'Bài Facebook cần có nội dung chữ, media hoặc link.',
    });
  }

  return { valid: issues.length === 0, issues };
}
