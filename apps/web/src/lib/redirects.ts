export function getSafeNextPath(fallback = '/dashboard'): string {
  if (typeof window === 'undefined') return fallback;
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !next.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}

export function withNextParam(path: string, nextPath: string): string {
  return `${path}?next=${encodeURIComponent(nextPath)}`;
}
