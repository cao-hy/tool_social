import type { PublishPostInput, ValidationResult, ValidationIssue } from '../core/types';

export function validateInstagramPost(input: PublishPostInput): ValidationResult {
  const issues: ValidationIssue[] = [];

  const hasImage = input.media.some((m) => m.type === 'IMAGE');
  const hasVideo = input.media.some((m) => m.type === 'VIDEO');

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
    }
  });

  // Caption giới hạn 2200 ký tự
  const fullCaption = [input.caption, input.hashtags?.map((t) => `#${t}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
  if (fullCaption.length > 2200) {
    issues.push({
      field: 'caption',
      message: 'Nội dung (bao gồm hashtag) vượt quá 2200 ký tự.',
      limit: 2200,
    });
  }

  return { valid: issues.length === 0, issues };
}
