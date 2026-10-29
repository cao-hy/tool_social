import { PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import type { ReplyTemplateView } from '@/lib/types';

export const AUTO_UTM_STORAGE_KEY = 'socialhub:comments:autoUtm';

const SOCIAL_HOST_SUFFIXES = [
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'pinterest.com',
  'pin.it',
];

export function platformShortLabel(platform: Platform): string {
  if (platform === 'FACEBOOK') return 'FB';
  if (platform === 'INSTAGRAM') return 'IG';
  if (platform === 'YOUTUBE') return 'YT';
  if (platform === 'TIKTOK') return 'TT';
  if (platform === 'PINTEREST') return 'PIN';
  return PLATFORM_LABELS[platform];
}

export function platformUtmSource(platform: Platform): string {
  if (platform === 'FACEBOOK') return 'fb';
  if (platform === 'INSTAGRAM') return 'ig';
  if (platform === 'YOUTUBE') return 'yt';
  if (platform === 'TIKTOK') return 'tt';
  if (platform === 'PINTEREST') return 'pin';
  return String(platform).toLowerCase();
}

export function isSocialPlatformHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return SOCIAL_HOST_SUFFIXES.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

export function hasEligibleStoreUrl(text: string): boolean {
  const matches = text.match(/https?:\/\/[^\s<>")]+/gi);
  if (!matches) return false;
  return matches.some((raw) => {
    const cleaned = raw.replace(/[.,;!]+$/, '');
    try {
      const parsed = new URL(cleaned);
      return !isSocialPlatformHost(parsed.hostname) && !parsed.searchParams.has('utm_source');
    } catch {
      return false;
    }
  });
}

export function attachUtmToUrlsInText(text: string, platform: Platform): string {
  return text.replace(/https?:\/\/[^\s<>")]+/gi, (rawMatch) => {
    const trailingMatch = rawMatch.match(/[.,;!]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const cleaned = trailing ? rawMatch.slice(0, -trailing.length) : rawMatch;
    try {
      const parsed = new URL(cleaned);
      if (isSocialPlatformHost(parsed.hostname) || parsed.searchParams.has('utm_source')) {
        return rawMatch;
      }
      parsed.searchParams.set('utm_source', platformUtmSource(platform));
      if (!parsed.searchParams.has('utm_medium')) {
        parsed.searchParams.set('utm_medium', 'cmt');
      }
      return `${parsed.toString()}${trailing}`;
    } catch {
      return rawMatch;
    }
  });
}

export function isTemplateMatchingStoreSlug(
  templateName: string,
  storeSlug: string | null | undefined,
): boolean {
  if (!storeSlug) return false;
  const slug = storeSlug.toLowerCase();
  const upper = templateName.trim().toUpperCase();
  if (slug.includes('preaureum')) {
    return upper.startsWith('PA ') || upper.startsWith('PA-') || upper.includes('PREAUREUM');
  }
  if (slug.includes('wrydeco')) {
    return upper.startsWith('WRY') || upper.includes('WRYDECO');
  }
  if (slug.includes('jeminise')) {
    return upper.startsWith('JEM') || upper.includes('JEMINISE');
  }
  if (slug.includes('chillgen')) {
    return upper.startsWith('CHILL') || upper.includes('CHILLGEN');
  }
  return upper.includes(slug.toUpperCase());
}

export function sortTemplatesForStoreSlugs(
  templates: ReplyTemplateView[],
  storeSlugs: string[],
): ReplyTemplateView[] {
  if (storeSlugs.length === 0) return templates;
  return [...templates].sort((a, b) => {
    const aMatch = storeSlugs.some((slug) => isTemplateMatchingStoreSlug(a.name, slug)) ? 1 : 0;
    const bMatch = storeSlugs.some((slug) => isTemplateMatchingStoreSlug(b.name, slug)) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Converts a ReplyTemplate body (which may end with `🔗` or `:`) into a bulk template with `{link}` placeholder.
 */
export function toVariableTemplateBody(rawBody: string): string {
  if (rawBody.includes('{link}')) return rawBody;
  const trimmed = rawBody.trimEnd();
  if (
    trimmed.endsWith('🔗') ||
    trimmed.endsWith('🛍️') ||
    trimmed.endsWith('👉') ||
    trimmed.endsWith('🛒') ||
    trimmed.endsWith(':')
  ) {
    return `${trimmed} {link}`;
  }
  return `${trimmed}\n🔗 {link}`;
}
