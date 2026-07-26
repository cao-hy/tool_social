import type { CapabilityKey, Paginated, Platform } from '@socialhub/shared';
import { describe, expect, it } from 'vitest';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import { createUnverifiedCapabilityTable } from '../core/capability-table';
import {
  AdapterNotRegisteredError,
  AdapterRegistry,
  findCapabilityMismatches,
} from '../core/registry';
import { emptyPostMetrics } from '@socialhub/shared';
import type { PlatformPostData } from '../core/types';

/**
 * Adapter giả CHỈ dùng cho test cấu trúc registry.
 * Nó không gọi mạng và không đại diện cho bất kỳ nền tảng thật nào —
 * đây là test kiến trúc, không phải test integration (prompt §21).
 */
function createFakeAdapter(
  platform: Platform,
  overrides: Partial<SocialPlatformAdapter> = {},
): SocialPlatformAdapter {
  const emptyPage: Paginated<PlatformPostData> = { items: [], nextCursor: null, hasMore: false };

  return {
    platform,
    capabilities: createUnverifiedCapabilityTable(platform),
    buildAuthorizationUrl: () => 'https://example.test/authorize',
    exchangeCodeForToken: async () => ({ accessToken: 'fake', scopes: [] }),
    getAccountProfile: async () => ({ externalAccountId: 'acc_1', name: 'Fake' }),
    validatePost: () => ({ valid: true, issues: [] }),
    publishPost: async () => ({ externalPostId: 'p_1', publishedAt: new Date() }),
    getPosts: async () => emptyPage,
    getPostMetrics: async () => emptyPostMetrics(),
    ...overrides,
  };
}

describe('AdapterRegistry', () => {
  it('đăng ký và lấy adapter theo nền tảng', () => {
    const registry = new AdapterRegistry();
    const adapter = createFakeAdapter('FACEBOOK');
    registry.register(adapter);

    expect(registry.get('FACEBOOK')).toBe(adapter);
    expect(registry.has('FACEBOOK')).toBe(true);
  });

  it('lấy adapter chưa đăng ký → lỗi có hướng dẫn cụ thể', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.get('TIKTOK')).toThrow(AdapterNotRegisteredError);
    expect(() => registry.get('TIKTOK')).toThrow(/ROADMAP/);
  });

  it('liệt kê được các nền tảng đã đăng ký', () => {
    const registry = new AdapterRegistry();
    registry.register(createFakeAdapter('FACEBOOK'));
    registry.register(createFakeAdapter('YOUTUBE'));
    expect(registry.getRegisteredPlatforms().sort()).toEqual(['FACEBOOK', 'YOUTUBE']);
  });
});

describe('requireCapability — cửa duy nhất cho thao tác optional', () => {
  it('capability UNVERIFIED → từ chối', () => {
    const registry = new AdapterRegistry();
    registry.register(createFakeAdapter('PINTEREST'));

    expect(() => registry.requireCapability('PINTEREST', 'replyToComment')).toThrow(/không hỗ trợ/);
  });

  it('capability SUPPORTED → cho qua', () => {
    const registry = new AdapterRegistry();
    const adapter = createFakeAdapter('FACEBOOK');
    adapter.capabilities.capabilities.replyToComment = {
      state: 'SUPPORTED',
      verifiedAt: '2026-07-01',
      verifiedBy: 'test',
    };
    registry.register(adapter);

    expect(() => registry.requireCapability('FACEBOOK', 'replyToComment')).not.toThrow();
  });

  it('capability CONDITIONAL → cho qua (điều kiện được kiểm tra ở tầng cao hơn)', () => {
    const registry = new AdapterRegistry();
    const adapter = createFakeAdapter('INSTAGRAM');
    adapter.capabilities.capabilities.publishVideo = {
      state: 'CONDITIONAL',
      condition: 'chỉ với tài khoản business',
    };
    registry.register(adapter);

    expect(() => registry.requireCapability('INSTAGRAM', 'publishVideo')).not.toThrow();
  });
});

describe('findCapabilityMismatches — code và ma trận không được trôi khỏi nhau', () => {
  it('adapter chưa xác minh gì và chưa cài method optional nào → không lệch', () => {
    expect(findCapabilityMismatches(createFakeAdapter('FACEBOOK'))).toEqual([]);
  });

  it('PHÁT HIỆN: cài method nhưng ma trận nói không hỗ trợ (tính năng bị ẩn oan)', () => {
    const adapter = createFakeAdapter('FACEBOOK', {
      replyToComment: async () => ({ externalReplyId: 'r_1', sentAt: new Date() }),
    });

    const mismatches = findCapabilityMismatches(adapter);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      method: 'replyToComment',
      problem: 'IMPLEMENTED_BUT_NOT_SUPPORTED',
    });
  });

  it('PHÁT HIỆN: ma trận nói hỗ trợ nhưng chưa cài method (UI hiện nút rồi crash)', () => {
    const adapter = createFakeAdapter('YOUTUBE');
    adapter.capabilities.capabilities.deleteComment = {
      state: 'SUPPORTED',
      verifiedAt: '2026-07-01',
      verifiedBy: 'test',
    };

    const mismatches = findCapabilityMismatches(adapter);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      method: 'deleteComment',
      problem: 'SUPPORTED_BUT_NOT_IMPLEMENTED',
    });
  });

  it('khớp cả hai chiều → không báo lệch', () => {
    const adapter = createFakeAdapter('FACEBOOK', {
      hideComment: async () => undefined,
    });
    adapter.capabilities.capabilities.hideComment = {
      state: 'SUPPORTED',
      verifiedAt: '2026-07-01',
      verifiedBy: 'test',
    };

    expect(findCapabilityMismatches(adapter)).toEqual([]);
  });

  it('kiểm tra được nhiều capability cùng lúc', () => {
    const adapter = createFakeAdapter('TIKTOK', {
      deletePost: async () => undefined,
      refreshToken: async () => ({ accessToken: 'x', scopes: [] }),
    });

    const mismatches = findCapabilityMismatches(adapter);
    const methods = mismatches.map((m) => m.method).sort();
    expect(methods).toEqual(['deletePost', 'refreshToken']);
  });
});

describe('ánh xạ method optional → capability là đầy đủ', () => {
  it('mọi method optional trong interface đều có capability tương ứng', () => {
    const adapter = createFakeAdapter('FACEBOOK');
    const capabilityKeys = Object.keys(adapter.capabilities.capabilities) as CapabilityKey[];

    for (const capability of [
      'replyToComment',
      'deleteComment',
      'hideComment',
      'deletePublishedPost',
      'refreshToken',
      'revokeToken',
    ] as CapabilityKey[]) {
      expect(capabilityKeys).toContain(capability);
    }
  });
});
