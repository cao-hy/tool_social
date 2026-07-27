import type { MediaAssetView } from '@/lib/types';

export function MediaPreview({
  asset,
  className = '',
}: {
  asset: MediaAssetView & { previewUrl?: string };
  className?: string;
}) {
  const source = asset.previewUrl ?? asset.readUrl;

  if (asset.type === 'IMAGE' && source) {
    return (
      <img
        alt={asset.originalFileName ?? 'media'}
        className={`aspect-video w-full rounded object-cover ${className}`}
        src={source}
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
