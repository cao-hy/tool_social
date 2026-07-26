import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  capabilityBlockReason,
  createUnverifiedCapabilities,
  isCapabilityUsable,
} from '../capabilities';

describe('capability — mặc định an toàn', () => {
  it('UNVERIFIED KHÔNG được coi là hỗ trợ', () => {
    expect(isCapabilityUsable({ state: 'UNVERIFIED' })).toBe(false);
  });

  it('undefined KHÔNG được coi là hỗ trợ', () => {
    expect(isCapabilityUsable(undefined)).toBe(false);
  });

  it('UNSUPPORTED không dùng được', () => {
    expect(isCapabilityUsable({ state: 'UNSUPPORTED' })).toBe(false);
  });

  it('SUPPORTED và CONDITIONAL dùng được', () => {
    expect(isCapabilityUsable({ state: 'SUPPORTED' })).toBe(true);
    expect(isCapabilityUsable({ state: 'CONDITIONAL', condition: 'chỉ với video' })).toBe(true);
  });

  it('mọi capability khởi tạo đều là UNVERIFIED — không đoán (prompt §7)', () => {
    const caps = createUnverifiedCapabilities();
    for (const key of CAPABILITY_KEYS) {
      expect(caps[key].state).toBe('UNVERIFIED');
    }
  });
});

describe('capabilityBlockReason', () => {
  it('tính năng dùng được thì không có lý do chặn', () => {
    expect(capabilityBlockReason({ state: 'SUPPORTED' })).toBeNull();
  });

  it('phân biệt "nền tảng không hỗ trợ" với "chưa xác minh"', () => {
    const unsupported = capabilityBlockReason({ state: 'UNSUPPORTED' });
    const unverified = capabilityBlockReason({ state: 'UNVERIFIED' });
    expect(unsupported).not.toBeNull();
    expect(unverified).not.toBeNull();
    expect(unsupported).not.toBe(unverified);
  });
});

describe('danh sách capability', () => {
  it('KHÔNG có capability nào cho hành vi bị prompt §3 cấm', () => {
    const forbidden = ['likePost', 'sharePost', 'followAccount', 'autoComment'];
    for (const key of forbidden) {
      expect(CAPABILITY_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it('có capability đọc like/share dưới dạng metric', () => {
    expect(CAPABILITY_KEYS).toContain('postLikes');
    expect(CAPABILITY_KEYS).toContain('postShares');
  });

  it('không có key trùng lặp', () => {
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length);
  });
});
