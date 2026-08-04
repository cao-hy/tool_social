import { X } from 'lucide-react';
import { useState } from 'react';
import { PrimaryButton, SecondaryButton } from './form-controls';
import type { ContentPostView } from '@/lib/types';
import { PLATFORM_LABELS, type Platform } from '@socialhub/shared';

export interface BulkPostCommentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPostIds: Set<string>;
  posts: ContentPostView[];
  onSubmit: (message: string) => Promise<void>;
  busy: boolean;
}

export function BulkPostCommentDrawer({
  isOpen,
  onClose,
  selectedPostIds,
  posts,
  onSubmit,
  busy,
}: BulkPostCommentDrawerProps) {
  const [message, setMessage] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  if (!isOpen) return null;

  const selectedPlatformPosts = posts
    .flatMap((post) => post.platformPosts || [])
    .filter((pPost) => selectedPostIds.has(pPost.id));

  // Tóm tắt nền tảng
  const platformCounts = selectedPlatformPosts.reduce(
    (acc, curr) => {
      acc[curr.platform] = (acc[curr.platform] || 0) + 1;
      return acc;
    },
    {} as Record<Platform, number>,
  );

  const handleSend = async () => {
    if (!message.trim()) return;
    await onSubmit(message);
    setMessage('');
    setShowPreview(false);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-40 xl:pointer-events-auto xl:static xl:z-auto xl:block xl:h-[calc(100vh-220px)] xl:min-h-[560px]">
      <button
        aria-label="Đóng"
        className="pointer-events-auto absolute inset-0 bg-slate-950/20 xl:hidden cursor-default"
        onClick={onClose}
        type="button"
      />
      <aside className="pointer-events-auto absolute right-0 top-0 flex h-full w-[85%] max-w-sm flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl xl:static xl:w-full xl:max-w-none xl:rounded-md xl:border xl:shadow-none">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Comment vào {selectedPostIds.size} bài đăng
            </h2>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
              {Object.entries(platformCounts).map(([platform, count]) => (
                <span key={platform} className="rounded-md bg-slate-100 px-2 py-1">
                  {count} {PLATFORM_LABELS[platform as Platform]}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
          {showPreview ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-900">Xem trước hiển thị</h3>
              {selectedPlatformPosts.slice(0, 5).map((pPost) => (
                <div key={pPost.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">
                      {pPost.socialAccountName}
                    </p>
                    <span className="text-[10px] text-slate-500">
                      {PLATFORM_LABELS[pPost.platform]}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{message}</p>
                </div>
              ))}
              {selectedPlatformPosts.length > 5 && (
                <p className="text-center text-xs text-slate-500">
                  ...và {selectedPlatformPosts.length - 5} bài khác
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-900">
                  Nội dung comment
                </label>
                <textarea
                  className="mt-2 min-h-[160px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  maxLength={2000}
                  placeholder="Nhập comment công khai..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="mt-1 text-right text-xs text-slate-500">{message.length}/2000</div>
              </div>
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <SecondaryButton onClick={onClose} disabled={busy} type="button">
              Hủy
            </SecondaryButton>
            <div className="flex gap-2">
              <SecondaryButton
                onClick={() => setShowPreview(!showPreview)}
                disabled={busy || !message.trim()}
                type="button"
              >
                {showPreview ? 'Chỉnh sửa' : 'Xem trước'}
              </SecondaryButton>
              <PrimaryButton onClick={handleSend} disabled={busy || !message.trim()} type="button">
                {busy ? 'Đang gửi...' : `Đưa ${selectedPostIds.size} comment vào hàng đợi`}
              </PrimaryButton>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  );
}
