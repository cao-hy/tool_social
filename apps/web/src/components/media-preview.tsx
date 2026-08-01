'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MediaAssetView } from '@/lib/types';

export function MediaPreview({
  asset,
  className = '',
}: {
  asset: MediaAssetView & { previewUrl?: string };
  className?: string;
}) {
  const sources = useMemo(() => mediaSources(asset), [asset]);
  const source = sources[0];

  if (asset.status === 'ARCHIVED') {
    if (source) {
      return (
        <div className={`relative overflow-hidden rounded ${className}`}>
          <FallbackImage
            alt={asset.originalFileName ?? 'media thumbnail'}
            className="aspect-video w-full object-cover"
            sources={sources}
          />
          <span className="absolute left-2 top-2 rounded bg-slate-950/75 px-2 py-1 text-[10px] font-semibold uppercase text-white">
            Đã dọn file gốc
          </span>
        </div>
      );
    }

    return (
      <div
        className={`flex flex-col items-center justify-center rounded bg-slate-100 p-4 text-center ${className}`}
      >
        <span className="text-xs font-semibold text-slate-500 uppercase">Media đã dọn dẹp</span>
        <span className="mt-1 text-[10px] text-slate-400">Xem lại trên Mạng Xã Hội</span>
      </div>
    );
  }

  if (asset.type === 'IMAGE' && source) {
    return (
      <FallbackImage
        alt={asset.originalFileName ?? 'media'}
        className={`aspect-video w-full rounded object-cover ${className}`}
        sources={sources}
      />
    );
  }

  if (asset.type === 'VIDEO' && source) {
    return (
      <video
        className={`aspect-video w-full rounded bg-slate-950 object-cover ${className}`}
        controls
        src={source}
      />
    );
  }

  return (
    <div
      className={`flex aspect-video w-full items-center justify-center rounded bg-slate-100 px-3 text-center text-xs font-medium text-slate-500 ${className}`}
    >
      {asset.originalFileName ?? asset.type}
    </div>
  );
}

export function FallbackImage({
  alt,
  className = '',
  sources,
}: {
  alt: string;
  className?: string;
  sources: string[];
}) {
  const stableSources = useMemo(() => uniqueUrls(sources), [sources]);
  const sourceKey = stableSources.join('\n');
  const [sourceIndex, setSourceIndex] = useState(0);
  const source = stableSources[sourceIndex];

  useEffect(() => {
    setSourceIndex(0);
  }, [sourceKey]);

  if (!source) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 px-2 text-center text-xs font-medium text-slate-500 ${className}`}
      >
        {alt}
      </div>
    );
  }

  return (
    <img
      alt={alt}
      className={className}
      onError={() => setSourceIndex((current) => Math.min(current + 1, stableSources.length))}
      src={source}
    />
  );
}

export function mediaPreviewSources(
  asset: MediaAssetView & { previewUrl?: string; updatedAt?: string },
): string[] {
  return mediaSources(asset);
}

export function mediaThumbnailSources(
  asset: MediaAssetView & { previewUrl?: string; updatedAt?: string },
): string[] {
  let urls: Array<string | null | undefined>;
  if (asset.type === 'VIDEO' && asset.status !== 'ARCHIVED') {
    urls = [asset.previewUrl, asset.thumbnailUrl];
  } else {
    urls = [asset.previewUrl, asset.thumbnailUrl, asset.displayUrl, asset.readUrl];
  }
  return uniqueUrls(urls.map((url) => appendVersion(url, asset.updatedAt)));
}

function mediaSources(
  asset: MediaAssetView & { previewUrl?: string; updatedAt?: string },
): string[] {
  let urls: Array<string | null | undefined>;
  if (asset.type === 'VIDEO' && asset.status !== 'ARCHIVED') {
    urls = [asset.previewUrl, asset.displayUrl, asset.readUrl, asset.thumbnailUrl];
  } else {
    urls = [asset.previewUrl, asset.thumbnailUrl, asset.displayUrl, asset.readUrl];
  }
  return uniqueUrls(urls.map((url) => appendVersion(url, asset.updatedAt)));
}

function appendVersion(
  url: string | null | undefined,
  updatedAt?: string | Date,
): string | null | undefined {
  if (!url || !updatedAt) return url;
  if (url.includes('X-Amz-Signature') || url.startsWith('blob:') || url.startsWith('data:'))
    return url;

  const v = typeof updatedAt === 'string' ? new Date(updatedAt).getTime() : updatedAt.getTime();
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${v}`;
}

function uniqueUrls(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
