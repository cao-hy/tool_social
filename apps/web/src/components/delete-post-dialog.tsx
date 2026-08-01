'use client';

import { PLATFORM_LABELS } from '@socialhub/shared';
import { useEffect, useMemo, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/form-controls';
import type { ContentPostView } from '@/lib/types';

interface DeletePostDialogProps {
  post: ContentPostView | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (input: { platformPostIds: string[] }) => void;
}

export function DeletePostDialog({
  post,
  busy = false,
  onCancel,
  onConfirm,
}: DeletePostDialogProps) {
  const remoteTargets = useMemo(
    () =>
      post?.platformPosts.filter((item) => item.status === 'PUBLISHED' && item.externalPostId) ??
      [],
    [post],
  );
  const [selectedPlatformPostIds, setSelectedPlatformPostIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedPlatformPostIds(remoteTargets.map((item) => item.id));
  }, [remoteTargets]);

  if (!post) return null;

  function togglePlatformPost(platformPostId: string) {
    setSelectedPlatformPostIds((current) =>
      current.includes(platformPostId)
        ? current.filter((item) => item !== platformPostId)
        : [...current, platformPostId],
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 py-6">
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Xóa bài viết</h2>
          <p className="mt-1 text-sm text-slate-600">
            Chọn nơi cần xóa. Bài trong server luôn được xóa khỏi workspace.
          </p>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
            <input checked disabled className="mt-1" type="checkbox" />
            <span>
              <span className="block font-semibold text-slate-950">Server / workspace</span>
              <span className="block text-slate-500">
                Xóa khỏi web quản lý và xóa media không còn được bài nào dùng.
              </span>
            </span>
          </label>

          {remoteTargets.length > 0 ? (
            remoteTargets.map((target) => (
              <label
                key={target.id}
                className="flex items-start gap-3 rounded-md border border-slate-200 px-3 py-3 text-sm"
              >
                <input
                  checked={selectedPlatformPostIds.includes(target.id)}
                  className="mt-1"
                  type="checkbox"
                  onChange={() => togglePlatformPost(target.id)}
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-950">
                    {PLATFORM_LABELS[target.platform]} - {target.socialAccountName}
                  </span>
                  <span className="block truncate text-slate-500">{target.externalPostId}</span>
                </span>
              </label>
            ))
          ) : (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
              Bài này chưa có bản publish trên nền tảng để xóa từ xa.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <SecondaryButton disabled={busy} onClick={onCancel} type="button">
            Hủy
          </SecondaryButton>
          <PrimaryButton
            busy={busy}
            onClick={() => onConfirm({ platformPostIds: selectedPlatformPostIds })}
            type="button"
          >
            Xóa
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
