import type { MediaAssetView } from '@/lib/types';

export function MediaPreview({
  asset,
  className = '',
}: {
  asset: MediaAssetView & { previewUrl?: string };
  className?: string;
}) {
  const source = asset.previewUrl ?? asset.displayUrl ?? asset.readUrl;

  if (asset.status === 'ARCHIVED') {
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
