import type { ContentPostView } from '@/lib/types';
import { MediaPreview } from '@/components/media-preview';
import { useState } from 'react';
import { useFloating, autoUpdate, flip, shift, offset } from '@floating-ui/react-dom';

const PLATFORM_COLORS: Record<string, string> = {
  FACEBOOK: 'bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-200',
  INSTAGRAM: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 hover:bg-fuchsia-200',
  YOUTUBE: 'bg-red-100 text-red-700 border-red-200 hover:bg-red-200',
  PINTEREST: 'bg-rose-100 text-rose-700 border-rose-200 hover:bg-rose-200',
  TIKTOK: 'bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700',
};

const DEFAULT_COLOR = 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200';

export function CalendarEvent({ post }: { post: ContentPostView }) {
  const [showPopover, setShowPopover] = useState(false);

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const platform = post.platformPosts[0]?.platform || 'UNKNOWN';
  const colorClass = PLATFORM_COLORS[platform] || DEFAULT_COLOR;

  const timeString = new Date(post.scheduledAt ?? '').toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <>
      <div
        ref={refs.setReference}
        onMouseEnter={() => setShowPopover(true)}
        onMouseLeave={() => setShowPopover(false)}
        className={`cursor-pointer truncate rounded-md border px-2 py-1 text-xs font-medium transition-colors ${colorClass}`}
      >
        <span className="mr-1 opacity-75">{timeString}</span>
        {post.title || 'Untitled'}
      </div>

      {showPopover && (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="z-50 mt-1 w-64 rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        >
          <p className="text-xs font-semibold text-brand-700">
            {new Date(post.scheduledAt ?? '').toLocaleString()}
          </p>
          <h4 className="mt-1 text-sm font-semibold text-slate-950">
            {post.title || 'Untitled post'}
          </h4>
          <p className="mt-2 line-clamp-3 text-xs text-slate-600">
            {post.body || 'Không có nội dung.'}
          </p>

          {post.media.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-1">
              {post.media.slice(0, 2).map((asset) => (
                <MediaPreview key={asset.id} asset={asset} />
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-1">
            {post.platformPosts.map((item) => (
              <span
                key={item.id}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600"
              >
                {item.platform}: {item.status}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
