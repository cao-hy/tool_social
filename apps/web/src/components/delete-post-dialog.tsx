'use client';

import {
  capabilityBlockReason,
  isCapabilityUsable,
  PLATFORM_LABELS,
  type Platform,
} from '@socialhub/shared';
import { useEffect, useMemo, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/form-controls';
import type { ContentPostView, PlatformCapabilitiesView } from '@/lib/types';

interface DeletePostDialogProps {
  post: ContentPostView | null;
  busy?: boolean;
  capabilityByPlatform?: Partial<Record<Platform, PlatformCapabilitiesView>>;
  onCancel: () => void;
  onConfirm: (input: { platformPostIds: string[] }) => void;
}

export function DeletePostDialog({
  post,
  busy = false,
  capabilityByPlatform,
  onCancel,
  onConfirm,
}: DeletePostDialogProps) {
  const remoteTargets = useMemo(
    () =>
      post?.platformPosts.filter((item) => item.status === 'PUBLISHED' && item.externalPostId) ??
      [],
    [post],
  );
  const targetStates = useMemo(
    () =>
      Object.fromEntries(
        remoteTargets.map((target) => {
          const capability =
            capabilityByPlatform?.[target.platform]?.capabilities.deletePublishedPost;
          const supported = capabilityByPlatform ? isCapabilityUsable(capability) : true;
          return [
            target.id,
            {
              supported,
              reason: supported
                ? null
                : (capability?.condition ??
                  capabilityBlockReason(capability) ??
                  'Nền tảng này chưa hỗ trợ xóa bài đã publish.'),
            },
          ];
        }),
      ) as Record<string, { supported: boolean; reason: string | null }>,
    [capabilityByPlatform, remoteTargets],
  );
  const selectableRemoteTargets = useMemo(
    () => remoteTargets.filter((target) => targetStates[target.id]?.supported ?? true),
    [remoteTargets, targetStates],
  );
  const unsupportedRemoteTargets = useMemo(
    () => remoteTargets.filter((target) => !(targetStates[target.id]?.supported ?? true)),
    [remoteTargets, targetStates],
  );
  const [selectedPlatformPostIds, setSelectedPlatformPostIds] = useState<string[]>([]);
  const selectedAllRemoteTargets =
    selectableRemoteTargets.length > 0 &&
    selectedPlatformPostIds.length === selectableRemoteTargets.length;
  const selectedSomeRemoteTargets =
    selectedPlatformPostIds.length > 0 &&
    selectedPlatformPostIds.length < selectableRemoteTargets.length;

  useEffect(() => {
    setSelectedPlatformPostIds(selectableRemoteTargets.map((item) => item.id));
  }, [selectableRemoteTargets]);

  if (!post) return null;

  function togglePlatformPost(platformPostId: string) {
    if (!(targetStates[platformPostId]?.supported ?? true)) return;
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
            Hệ thống sẽ xóa trên nền tảng trước. Chỉ khi các target cần xóa đều thành công thì mới
            xóa bài khỏi workspace.
          </p>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
            <input checked disabled className="mt-1" type="checkbox" />
            <span>
              <span className="block font-semibold text-slate-950">
                Server / workspace {selectedSomeRemoteTargets ? '(giữ lại bài cha)' : ''}
              </span>
              <span className="block text-slate-500">
                {selectedSomeRemoteTargets
                  ? 'Bạn đang chọn một phần target, nên chỉ xóa target đó và giữ bài cha cho các social còn lại.'
                  : selectedAllRemoteTargets
                    ? 'Nếu các target đã chọn xóa thành công và không còn social published nào khác, bài sẽ bị xóa khỏi workspace và media không còn dùng sẽ được dọn.'
                    : 'Xóa khỏi workspace, hủy lịch/job và dọn media không còn được bài nào dùng.'}
              </span>
            </span>
          </label>

          {unsupportedRemoteTargets.length > 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {unsupportedRemoteTargets.length} target không thể xóa qua API nên đã được bỏ chọn.
              Nếu tiếp tục, hệ thống chỉ xóa dữ liệu server/workspace; bài đã đăng trên nền tảng đó
              vẫn có thể còn tồn tại.
            </p>
          ) : null}
          {remoteTargets.length > 0 && selectedPlatformPostIds.length === 0 ? (
            <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              Bạn đang chọn xóa server/workspace. Hệ thống sẽ không gọi API xóa bài trên social.
            </p>
          ) : null}

          {remoteTargets.length > 0 ? (
            remoteTargets.map((target) => {
              const targetState = targetStates[target.id] ?? { supported: true, reason: null };
              return (
                <label
                  key={target.id}
                  className={`flex items-start gap-3 rounded-md border px-3 py-3 text-sm ${
                    targetState.supported
                      ? 'border-slate-200'
                      : 'border-amber-200 bg-amber-50/70 text-slate-500'
                  }`}
                >
                  <input
                    checked={targetState.supported && selectedPlatformPostIds.includes(target.id)}
                    className="mt-1"
                    disabled={!targetState.supported || busy}
                    type="checkbox"
                    onChange={() => togglePlatformPost(target.id)}
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold text-slate-950">
                      {PLATFORM_LABELS[target.platform]} - {target.socialAccountName}
                    </span>
                    <span className="block truncate text-slate-500">{target.externalPostId}</span>
                    {!targetState.supported ? (
                      <span className="mt-1 block text-xs font-medium text-amber-800">
                        Không thể xóa qua API: {targetState.reason}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })
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
