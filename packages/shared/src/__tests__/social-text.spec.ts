import { describe, expect, it } from 'vitest';
import {
  countGraphemes,
  normalizeHashtags,
  normalizeOptionalSocialText,
  normalizeSocialText,
  splitAndNormalizeHashtags,
  truncateGraphemes,
} from '../social-text';

describe('social text helpers', () => {
  it('giữ emoji/icon nhưng bỏ control chars nguy hiểm', () => {
    expect(normalizeSocialText('  Xin chào ✨\u0000\u200B\n🚀  ')).toBe('Xin chào ✨\n🚀');
  });

  it('trả undefined cho text rỗng sau normalize', () => {
    expect(normalizeOptionalSocialText(' \u0000\u200B ')).toBeUndefined();
  });

  it('normalize hashtag, bỏ dấu # và chống duplicate', () => {
    expect(normalizeHashtags(['#Sale', ' sale ', '✨deal', ''])).toEqual(['Sale', '✨deal']);
  });

  it('tách hashtag theo khoảng trắng, dấu phẩy và dấu phân cách phổ biến', () => {
    expect(splitAndNormalizeHashtags('#sale, #new；đẹp')).toEqual(['sale', 'new', 'đẹp']);
  });

  it('đếm và cắt theo grapheme để không cắt vỡ emoji', () => {
    const value = 'A👨‍👩‍👧‍👦B';
    expect(countGraphemes(value)).toBe(3);
    expect(truncateGraphemes(value, 2)).toBe('A👨‍👩‍👧‍👦');
  });
});
