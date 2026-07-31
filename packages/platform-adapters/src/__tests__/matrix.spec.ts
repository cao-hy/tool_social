import { PLATFORMS } from '@socialhub/shared';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_MATRIX,
  getCapabilityTable,
  getVerificationProgress,
  POLICY_EXCLUDED_ACTIONS,
} from '../capabilities/matrix';
import { countVerified, findStaleCapabilities, isSupported } from '../core/capability-table';

describe('CAPABILITY_MATRIX — trạng thái xác minh (prompt §7, §21)', () => {
  const verifiedCounts = {
    FACEBOOK: 4,
    INSTAGRAM: 14,
    PINTEREST: 14,
    TIKTOK: 10,
    YOUTUBE: 8,
  } as const;

  it('có bảng cho cả 5 nền tảng', () => {
    for (const platform of PLATFORMS) {
      expect(CAPABILITY_MATRIX[platform]).toBeDefined();
      expect(CAPABILITY_MATRIX[platform].platform).toBe(platform);
    }
  });

  it('chỉ các capability đã có nguồn xác minh mới rời UNVERIFIED', () => {
    for (const platform of PLATFORMS) {
      const { verified, total } = countVerified(CAPABILITY_MATRIX[platform]);
      expect(total).toBeGreaterThan(0);
      expect(verified).toBe(verifiedCounts[platform]);
    }
    expect(CAPABILITY_MATRIX.FACEBOOK.capabilities.readComments).toMatchObject({
      state: 'CONDITIONAL',
      source: expect.stringContaining('developers.facebook.com'),
      verifiedAt: '2026-07-28',
    });
  });

  it('UNVERIFIED KHÔNG được coi là hỗ trợ — chỉ capability đã xác minh mới dùng được', () => {
    for (const platform of PLATFORMS) {
      const table = CAPABILITY_MATRIX[platform];
      for (const key of Object.keys(table.capabilities) as Array<keyof typeof table.capabilities>) {
        expect(isSupported(table, key)).toBe(
          (platform === 'FACEBOOK' &&
            (key === 'readComments' ||
              key === 'replyToComment' ||
              key === 'editPublishedPost' ||
              key === 'deletePublishedPost')) ||
            (platform === 'PINTEREST' &&
              (key === 'publishImage' ||
                key === 'publishVideo' ||
                key === 'publishWithLink' ||
                key === 'editPublishedPost' ||
                key === 'deletePublishedPost' ||
                key === 'postViews' ||
                key === 'postLikes' ||
                key === 'postCommentCount' ||
                key === 'postImpressions' ||
                key === 'postSaves' ||
                key === 'refreshToken')) ||
            (platform === 'INSTAGRAM' &&
              (key === 'publishImage' ||
                key === 'publishMultipleImages' ||
                key === 'publishVideo' ||
                key === 'deletePublishedPost' ||
                key === 'readComments' ||
                key === 'replyToComment' ||
                key === 'postViews' ||
                key === 'postLikes' ||
                key === 'postCommentCount' ||
                key === 'postShares' ||
                key === 'postReach' ||
                key === 'postImpressions' ||
                key === 'postSaves')) ||
            (platform === 'YOUTUBE' &&
              (key === 'publishVideo' ||
                key === 'postTitle' ||
                key === 'refreshToken' ||
                key === 'revokeToken' ||
                key === 'readComments' ||
                key === 'replyToComment' ||
                key === 'editPublishedPost' ||
                key === 'deletePublishedPost')) ||
            (platform === 'TIKTOK' &&
              (key === 'publishImage' ||
                key === 'publishVideo' ||
                key === 'postViews' ||
                key === 'postLikes' ||
                key === 'postCommentCount' ||
                key === 'postShares' ||
                key === 'refreshToken' ||
                key === 'revokeToken')),
        );
      }
    }
  });

  it('mọi giới hạn media đều null (chưa xác minh) và validator sẽ bỏ qua', () => {
    for (const platform of PLATFORMS) {
      const { limits } = CAPABILITY_MATRIX[platform];
      expect(limits.captionMaxLength).toBeNull();
      expect(limits.videoMaxBytes).toBeNull();
      expect(limits.allowedImageMimeTypes).toEqual([]);
    }
  });

  it('tiến độ xác minh báo cáo trung thực', () => {
    const progress = getVerificationProgress();
    for (const platform of PLATFORMS) {
      expect(progress[platform].verified).toBe(verifiedCounts[platform]);
      expect(progress[platform].percent).toBe(
        platform === 'FACEBOOK'
          ? 13
          : platform === 'INSTAGRAM'
            ? 44
            : platform === 'PINTEREST'
              ? 44
              : platform === 'YOUTUBE'
                ? 25
                : platform === 'TIKTOK'
                  ? 31
                  : 0,
      );
    }
  });

  it('bảng của mỗi nền tảng là instance riêng — sửa cái này không ảnh hưởng cái kia', () => {
    const facebook = getCapabilityTable('FACEBOOK');
    const instagram = getCapabilityTable('INSTAGRAM');
    expect(facebook.capabilities).not.toBe(instagram.capabilities);
    expect(facebook.limits).not.toBe(instagram.limits);
  });
});

describe('hành động bị chính sách dự án loại trừ (prompt §3)', () => {
  it('like/share/follow KHÔNG nằm trong capability matrix', () => {
    for (const platform of PLATFORMS) {
      const keys = Object.keys(CAPABILITY_MATRIX[platform].capabilities);
      for (const excluded of POLICY_EXCLUDED_ACTIONS) {
        expect(keys).not.toContain(excluded);
      }
    }
  });

  it('danh sách loại trừ bao gồm mọi hành vi tương tác giả', () => {
    expect(POLICY_EXCLUDED_ACTIONS).toContain('likePost');
    expect(POLICY_EXCLUDED_ACTIONS).toContain('sharePost');
    expect(POLICY_EXCLUDED_ACTIONS).toContain('followAccount');
    expect(POLICY_EXCLUDED_ACTIONS).toContain('autoComment');
  });

  it('nhưng likes/shares VẪN đọc được dưới dạng metric', () => {
    const keys = Object.keys(CAPABILITY_MATRIX.FACEBOOK.capabilities);
    expect(keys).toContain('postLikes');
    expect(keys).toContain('postShares');
  });
});

describe('findStaleCapabilities — kết luận cũ phải được rà lại', () => {
  it('bảng chưa xác minh thì không có gì cũ', () => {
    expect(findStaleCapabilities(CAPABILITY_MATRIX.TIKTOK)).toEqual([]);
  });

  it('phát hiện capability xác minh quá 90 ngày', () => {
    const table = getCapabilityTable('PINTEREST');
    const modified = {
      ...table,
      capabilities: {
        ...table.capabilities,
        readComments: {
          state: 'SUPPORTED' as const,
          source: 'https://developers.pinterest.com/docs/api/v5/',
          verifiedAt: '2024-01-01',
          verifiedBy: 'test',
        },
      },
    };
    expect(findStaleCapabilities(modified, new Date('2024-12-01'))).toContain('readComments');
  });

  it('capability xác minh gần đây không bị coi là cũ', () => {
    const table = getCapabilityTable('PINTEREST');
    const modified = {
      ...table,
      capabilities: {
        ...table.capabilities,
        readComments: {
          state: 'SUPPORTED' as const,
          verifiedAt: '2024-11-15',
          verifiedBy: 'test',
        },
      },
    };
    expect(findStaleCapabilities(modified, new Date('2024-12-01'))).toEqual([]);
  });
});
