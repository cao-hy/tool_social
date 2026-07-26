import type { PlatformLimits } from './capability-table';
import type { PublishPostInput, ValidationIssue, ValidationResult } from './types';

/**
 * Validation dùng chung, chạy trước validator riêng của từng nền tảng.
 *
 * NGUYÊN TẮC QUAN TRỌNG: giới hạn có giá trị `null` nghĩa là CHƯA XÁC MINH, và
 * sẽ được BỎ QUA — không kiểm tra. Đoán một con số ở đây dẫn tới một trong hai
 * kết cục tệ:
 *   • chặn nhầm nội dung hợp lệ (người dùng bực mà không hiểu vì sao), hoặc
 *   • để lọt nội dung mà nền tảng sẽ từ chối — và điều đó chỉ lộ ra khi bài
 *     đăng thất bại, tức là sau khi người dùng đã tin rằng mọi thứ ổn.
 *
 * Cái giá của việc bỏ qua là bài đăng có thể thất bại ở nền tảng; cái giá của
 * việc đoán là hệ thống nói dối. Bỏ qua là lựa chọn đúng.
 */
export function validateAgainstLimits(
  input: PublishPostInput,
  limits: PlatformLimits,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  const caption = input.caption ?? '';
  if (limits.captionMaxLength !== null && caption.length > limits.captionMaxLength) {
    issues.push({
      field: 'caption',
      message: `Caption dài ${caption.length} ký tự, vượt giới hạn ${limits.captionMaxLength}.`,
      limit: limits.captionMaxLength,
    });
  }

  if (
    limits.titleMaxLength !== null &&
    input.title !== undefined &&
    input.title.length > limits.titleMaxLength
  ) {
    issues.push({
      field: 'title',
      message: `Title dài ${input.title.length} ký tự, vượt giới hạn ${limits.titleMaxLength}.`,
      limit: limits.titleMaxLength,
    });
  }

  const hashtags = input.hashtags ?? [];
  if (limits.maxHashtags !== null && hashtags.length > limits.maxHashtags) {
    issues.push({
      field: 'hashtags',
      message: `Có ${hashtags.length} hashtag, vượt giới hạn ${limits.maxHashtags}.`,
      limit: limits.maxHashtags,
    });
  }

  const images = input.media.filter((m) => m.type === 'IMAGE');
  const videos = input.media.filter((m) => m.type === 'VIDEO');

  if (limits.maxImagesPerPost !== null && images.length > limits.maxImagesPerPost) {
    issues.push({
      field: 'media',
      message: `Có ${images.length} ảnh, vượt giới hạn ${limits.maxImagesPerPost}.`,
      limit: limits.maxImagesPerPost,
    });
  }

  for (const [index, image] of images.entries()) {
    if (limits.imageMaxBytes !== null && image.sizeBytes > limits.imageMaxBytes) {
      issues.push({
        field: `media[${index}]`,
        message: `Ảnh nặng ${formatBytes(image.sizeBytes)}, vượt giới hạn ${formatBytes(limits.imageMaxBytes)}.`,
        limit: limits.imageMaxBytes,
      });
    }
    if (
      limits.allowedImageMimeTypes.length > 0 &&
      !limits.allowedImageMimeTypes.includes(image.mimeType)
    ) {
      issues.push({
        field: `media[${index}]`,
        message: `Định dạng ảnh ${image.mimeType} không được hỗ trợ. Cho phép: ${limits.allowedImageMimeTypes.join(', ')}.`,
      });
    }
  }

  for (const [index, video] of videos.entries()) {
    if (limits.videoMaxBytes !== null && video.sizeBytes > limits.videoMaxBytes) {
      issues.push({
        field: `media[${index}]`,
        message: `Video nặng ${formatBytes(video.sizeBytes)}, vượt giới hạn ${formatBytes(limits.videoMaxBytes)}.`,
        limit: limits.videoMaxBytes,
      });
    }
    if (
      limits.allowedVideoMimeTypes.length > 0 &&
      !limits.allowedVideoMimeTypes.includes(video.mimeType)
    ) {
      issues.push({
        field: `media[${index}]`,
        message: `Định dạng video ${video.mimeType} không được hỗ trợ. Cho phép: ${limits.allowedVideoMimeTypes.join(', ')}.`,
      });
    }
    if (video.durationSec !== undefined) {
      if (limits.videoMinDurationSec !== null && video.durationSec < limits.videoMinDurationSec) {
        issues.push({
          field: `media[${index}]`,
          message: `Video dài ${video.durationSec}s, ngắn hơn mức tối thiểu ${limits.videoMinDurationSec}s.`,
          limit: limits.videoMinDurationSec,
        });
      }
      if (limits.videoMaxDurationSec !== null && video.durationSec > limits.videoMaxDurationSec) {
        issues.push({
          field: `media[${index}]`,
          message: `Video dài ${video.durationSec}s, vượt mức tối đa ${limits.videoMaxDurationSec}s.`,
          limit: limits.videoMaxDurationSec,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Gộp nhiều kết quả validation — validator riêng của nền tảng chạy nối tiếp. */
export function mergeValidationResults(...results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((r) => r.issues);
  return { valid: issues.length === 0, issues };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
