const ZERO_WIDTH_FORMAT_CHARS = /[\u200B\u200C\u200E\u200F\uFEFF]/g;
const HASHTAG_SEPARATORS = /[\s,，、;；]+/gu;

export function normalizeSocialText(value: string): string {
  return stripControlCharsExceptLineBreaks(value.normalize('NFC').replace(/\r\n?/g, '\n'))
    .replace(ZERO_WIDTH_FORMAT_CHARS, '')
    .trim();
}

export function normalizeOptionalSocialText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeSocialText(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeHashtag(value: string): string {
  return normalizeSocialText(value).replace(/^#+/u, '').replace(HASHTAG_SEPARATORS, '');
}

export function normalizeHashtags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeHashtag(value);
    if (!normalized) continue;

    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

export function splitAndNormalizeHashtags(value: string): string[] {
  return normalizeHashtags(value.split(HASHTAG_SEPARATORS));
}

export function countGraphemes(value: string): number {
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) return Array.from(value).length;
  return Array.from(segmenter.segment(value)).length;
}

export function truncateGraphemes(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) return Array.from(value).slice(0, maxLength).join('');
  return Array.from(segmenter.segment(value))
    .slice(0, maxLength)
    .map((segment) => segment.segment)
    .join('');
}

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  return new Intl.Segmenter(undefined, { granularity: 'grapheme' });
}

function stripControlCharsExceptLineBreaks(value: string): string {
  let result = '';

  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0x0a) {
      result += char;
      continue;
    }
    if (codePoint <= 0x1f || codePoint === 0x7f) continue;
    result += char;
  }

  return result;
}
