import { PLATFORM_LABELS } from '@socialhub/shared';
import type { Platform } from '@socialhub/shared';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Field, SelectInput, TextInput } from '@/components/form-controls';
import { socialAccountsApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';
import {
  type CommonComposerContent,
  platformOverrideDefaults,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import type {
  MediaAssetView,
  PinterestBoardSectionView,
  PinterestBoardView,
  SocialAccountView,
  TikTokCreatorInfoView,
} from '@/lib/types';

interface PlatformComposerPanelsProps {
  accounts: SocialAccountView[];
  mediaAssets: MediaAssetView[];
  drafts: Record<string, PlatformOverrideDraft>;
  disabled?: boolean;
  mediaLocked?: boolean;
  workspaceId?: string;
  common?: CommonComposerContent & {
    hashtags?: string;
  };
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
}

export function PlatformComposerPanels({
  accounts,
  mediaAssets,
  drafts,
  disabled = false,
  mediaLocked = false,
  workspaceId,
  common,
  onChange,
}: PlatformComposerPanelsProps) {
  const [expandedAccountIds, setExpandedAccountIds] = useState<string[]>([]);
  const [creatorInfoByAccountId, setCreatorInfoByAccountId] = useState<
    Record<string, TikTokCreatorInfoView>
  >({});
  const [creatorLoadingIds, setCreatorLoadingIds] = useState<string[]>([]);
  const [creatorErrors, setCreatorErrors] = useState<Record<string, string>>({});
  const [pinterestBoardsByAccountId, setPinterestBoardsByAccountId] = useState<
    Record<string, PinterestBoardView[]>
  >({});
  const [pinterestBoardLoadingIds, setPinterestBoardLoadingIds] = useState<string[]>([]);
  const [pinterestBoardErrors, setPinterestBoardErrors] = useState<Record<string, string>>({});
  const [pinterestSectionsByKey, setPinterestSectionsByKey] = useState<
    Record<string, PinterestBoardSectionView[]>
  >({});
  const [pinterestSectionLoadingKeys, setPinterestSectionLoadingKeys] = useState<string[]>([]);
  const [pinterestSectionErrors, setPinterestSectionErrors] = useState<Record<string, string>>({});
  const tiktokAccountKey = accounts
    .filter((account) => account.platform === 'TIKTOK')
    .map((account) => `${account.id}:${account.scopes.join(',')}`)
    .join('|');
  const pinterestAccountKey = accounts
    .filter((account) => account.platform === 'PINTEREST')
    .map((account) => `${account.id}:${account.scopes.join(',')}`)
    .join('|');

  useEffect(() => {
    if (!workspaceId) return;
    for (const account of accounts) {
      if (account.platform !== 'TIKTOK') continue;
      if (!account.scopes.includes('video.publish')) continue;
      if (creatorErrors[account.id]) continue;
      if (creatorInfoByAccountId[account.id] || creatorLoadingIds.includes(account.id)) continue;
      void loadTikTokCreatorInfo(account.id);
    }
  }, [workspaceId, tiktokAccountKey, creatorInfoByAccountId, creatorLoadingIds, creatorErrors]);

  useEffect(() => {
    if (!workspaceId) return;
    for (const account of accounts) {
      if (account.platform !== 'PINTEREST') continue;
      if (!account.scopes.includes('boards:read')) continue;
      if (pinterestBoardErrors[account.id]) continue;
      if (pinterestBoardsByAccountId[account.id] || pinterestBoardLoadingIds.includes(account.id)) {
        continue;
      }
      void loadPinterestBoards(account.id);
    }
  }, [
    workspaceId,
    pinterestAccountKey,
    pinterestBoardsByAccountId,
    pinterestBoardLoadingIds,
    pinterestBoardErrors,
  ]);

  if (accounts.length === 0) return null;

  async function loadTikTokCreatorInfo(accountId: string) {
    if (!workspaceId) return;
    setCreatorLoadingIds((current) =>
      current.includes(accountId) ? current : [...current, accountId],
    );
    setCreatorErrors((current) => {
      const next = { ...current };
      delete next[accountId];
      return next;
    });
    try {
      const creatorInfo = await socialAccountsApi.tiktokCreatorInfo(workspaceId, accountId);
      setCreatorInfoByAccountId((current) => ({ ...current, [accountId]: creatorInfo }));
    } catch (error) {
      setCreatorErrors((current) => ({ ...current, [accountId]: getErrorMessage(error) }));
    } finally {
      setCreatorLoadingIds((current) => current.filter((id) => id !== accountId));
    }
  }

  async function loadPinterestBoards(accountId: string) {
    if (!workspaceId) return;
    setPinterestBoardLoadingIds((current) =>
      current.includes(accountId) ? current : [...current, accountId],
    );
    setPinterestBoardErrors((current) => {
      const next = { ...current };
      delete next[accountId];
      return next;
    });
    try {
      const response = await socialAccountsApi.pinterestBoards(workspaceId, accountId);
      setPinterestBoardsByAccountId((current) => ({ ...current, [accountId]: response.items }));
    } catch (error) {
      setPinterestBoardErrors((current) => ({ ...current, [accountId]: getErrorMessage(error) }));
    } finally {
      setPinterestBoardLoadingIds((current) => current.filter((id) => id !== accountId));
    }
  }

  async function loadPinterestBoardSections(accountId: string, boardId: string) {
    if (!workspaceId || !boardId) return;
    const key = pinterestSectionKey(accountId, boardId);
    setPinterestSectionLoadingKeys((current) =>
      current.includes(key) ? current : [...current, key],
    );
    setPinterestSectionErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const response = await socialAccountsApi.pinterestBoardSections(
        workspaceId,
        accountId,
        boardId,
      );
      setPinterestSectionsByKey((current) => ({ ...current, [key]: response.items }));
    } catch (error) {
      setPinterestSectionErrors((current) => ({ ...current, [key]: getErrorMessage(error) }));
    } finally {
      setPinterestSectionLoadingKeys((current) => current.filter((item) => item !== key));
    }
  }

  function toggleExpanded(accountId: string) {
    setExpandedAccountIds((current) =>
      current.includes(accountId)
        ? current.filter((item) => item !== accountId)
        : [...current, accountId],
    );
  }

  function toggleCustomized(accountId: string, customized: boolean) {
    onChange(accountId, { customized });
    if (customized) {
      setExpandedAccountIds((current) =>
        current.includes(accountId) ? current : [...current, accountId],
      );
    } else {
      setExpandedAccountIds((current) => current.filter((item) => item !== accountId));
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-950">Nội dung riêng từng nền tảng</h2>
          <p className="mt-1 text-sm text-slate-600">
            Chọn Tùy chỉnh khi target cần caption, link, media hoặc option khác nội dung chung. Nội
            dung chung sẽ được điền sẵn để sửa nhanh.
          </p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">
          {accounts.length} target
        </span>
      </div>

      <div className="grid gap-2">
        {accounts.map((account) => {
          const draft =
            drafts[account.id] ?? platformOverrideDefaults(account.platform, account.scopes);
          const issues = platformChecklist(account.platform, resolveMedia(draft, mediaAssets));
          const expanded = expandedAccountIds.includes(account.id);
          const tone = platformPanelTone(account.platform);
          return (
            <article
              key={account.id}
              className={`overflow-hidden rounded-md border bg-white ${tone.article}`}
            >
              <div
                className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${tone.header}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-950">{account.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}
                    >
                      {PLATFORM_LABELS[account.platform]}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{account.username ?? account.id}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      issues.length === 0
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {issues.length === 0 ? 'Sẵn sàng' : `${issues.length} cần sửa`}
                  </span>
                  <ModeSegmentedControl
                    customized={draft.customized}
                    disabled={disabled}
                    onChange={(customized) => toggleCustomized(account.id, customized)}
                  />
                  <button
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm"
                    title={expanded ? 'Thu gọn' : 'Mở chi tiết'}
                    type="button"
                    onClick={() => toggleExpanded(account.id)}
                  >
                    <ChevronDown className={`h-4 w-4 transition ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                </div>
              </div>

              {expanded ? (
                <div className="space-y-3 border-t border-slate-100 px-4 py-3">
                  <div className="grid gap-2 text-xs text-slate-600 md:grid-cols-3">
                    <InheritedChip label="Text" value={commonTextSummary(common)} />
                    <InheritedChip
                      label="Media"
                      value={mediaSummary(resolveMedia(draft, mediaAssets))}
                    />
                    <InheritedChip
                      label="Mode"
                      value={
                        draft.customized ? 'Riêng target này' : platformModeHint(account.platform)
                      }
                    />
                  </div>

                  {issues.length > 0 ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {issues.join(' · ')}
                    </div>
                  ) : null}

                  {draft.customized ? (
                    <PlatformFields
                      account={account}
                      disabled={disabled}
                      draft={draft}
                      mediaLocked={mediaLocked}
                      mediaAssets={mediaAssets}
                      pinterestBoards={pinterestBoardsByAccountId[account.id] ?? []}
                      pinterestBoardsError={pinterestBoardErrors[account.id]}
                      pinterestBoardsLoading={pinterestBoardLoadingIds.includes(account.id)}
                      pinterestSections={
                        draft.pinterestBoardId
                          ? (pinterestSectionsByKey[
                              pinterestSectionKey(account.id, draft.pinterestBoardId)
                            ] ?? [])
                          : []
                      }
                      pinterestSectionsError={
                        draft.pinterestBoardId
                          ? pinterestSectionErrors[
                              pinterestSectionKey(account.id, draft.pinterestBoardId)
                            ]
                          : undefined
                      }
                      pinterestSectionsLoading={
                        draft.pinterestBoardId
                          ? pinterestSectionLoadingKeys.includes(
                              pinterestSectionKey(account.id, draft.pinterestBoardId),
                            )
                          : false
                      }
                      tiktokCreatorInfo={creatorInfoByAccountId[account.id]}
                      tiktokCreatorInfoError={creatorErrors[account.id]}
                      tiktokCreatorInfoLoading={creatorLoadingIds.includes(account.id)}
                      onLoadPinterestSections={(boardId) =>
                        loadPinterestBoardSections(account.id, boardId)
                      }
                      onRefreshPinterestBoards={() => loadPinterestBoards(account.id)}
                      onRefreshTikTokCreatorInfo={() => loadTikTokCreatorInfo(account.id)}
                      onChange={onChange}
                    />
                  ) : (
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                      Target này đang lấy tiêu đề, nội dung, link, hashtag và media từ phần nội dung
                      chung.
                    </div>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ModeSegmentedControl({
  customized,
  disabled,
  onChange,
}: {
  customized: boolean;
  disabled: boolean;
  onChange: (customized: boolean) => void;
}) {
  const baseClass =
    'h-8 rounded px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
      <button
        className={`${baseClass} ${
          customized
            ? 'text-slate-600 hover:bg-white hover:text-slate-950'
            : 'bg-white text-slate-950 shadow-sm'
        }`}
        disabled={disabled}
        type="button"
        onClick={() => onChange(false)}
      >
        Dùng chung
      </button>
      <button
        className={`${baseClass} ${
          customized
            ? 'bg-brand-600 text-white shadow-sm hover:bg-brand-700'
            : 'text-slate-600 hover:bg-white hover:text-slate-950'
        }`}
        disabled={disabled}
        type="button"
        onClick={() => onChange(true)}
      >
        Tùy chỉnh
      </button>
    </div>
  );
}

function InheritedChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 px-3 py-2">
      <span className="block font-medium text-slate-500">{label}</span>
      <span className="mt-0.5 block truncate text-slate-800">{value}</span>
    </div>
  );
}

function PlatformFields({
  account,
  disabled,
  draft,
  mediaLocked,
  mediaAssets,
  pinterestBoards,
  pinterestBoardsError,
  pinterestBoardsLoading,
  pinterestSections,
  pinterestSectionsError,
  pinterestSectionsLoading,
  tiktokCreatorInfo,
  tiktokCreatorInfoError,
  tiktokCreatorInfoLoading,
  onLoadPinterestSections,
  onRefreshPinterestBoards,
  onRefreshTikTokCreatorInfo,
  onChange,
}: {
  account: SocialAccountView;
  disabled: boolean;
  draft: PlatformOverrideDraft;
  mediaLocked: boolean;
  mediaAssets: MediaAssetView[];
  pinterestBoards: PinterestBoardView[];
  pinterestBoardsError?: string;
  pinterestBoardsLoading: boolean;
  pinterestSections: PinterestBoardSectionView[];
  pinterestSectionsError?: string;
  pinterestSectionsLoading: boolean;
  tiktokCreatorInfo?: TikTokCreatorInfoView;
  tiktokCreatorInfoError?: string;
  tiktokCreatorInfoLoading?: boolean;
  onLoadPinterestSections: (boardId: string) => void;
  onRefreshPinterestBoards: () => void;
  onRefreshTikTokCreatorInfo: () => void;
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
}) {
  const resolvedMedia = resolveMedia(draft, mediaAssets);

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        {titleLabel(account.platform) ? (
          <Field label={titleLabel(account.platform) ?? 'Title riêng'}>
            <TextInput
              disabled={disabled}
              placeholder={titlePlaceholder(account.platform)}
              value={draft.title}
              onChange={(event) => onChange(account.id, { title: event.target.value })}
            />
          </Field>
        ) : null}

        {linkLabel(account.platform) ? (
          <Field label={linkLabel(account.platform) ?? 'Link riêng'}>
            <TextInput
              disabled={disabled}
              placeholder="https://..."
              value={draft.linkUrl}
              onChange={(event) => onChange(account.id, { linkUrl: event.target.value })}
            />
          </Field>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {captionLabel(account.platform) ? (
          <Field label={captionLabel(account.platform) ?? 'Caption riêng'}>
            <textarea
              className="min-h-28 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100"
              disabled={disabled}
              value={draft.caption}
              onChange={(event) => onChange(account.id, { caption: event.target.value })}
            />
          </Field>
        ) : null}

        {descriptionLabel(account.platform) ? (
          <Field label={descriptionLabel(account.platform) ?? 'Description riêng'}>
            <textarea
              className="min-h-28 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100"
              disabled={disabled}
              value={draft.description}
              onChange={(event) => onChange(account.id, { description: event.target.value })}
            />
          </Field>
        ) : null}
      </div>

      <PlatformOptions
        account={account}
        disabled={disabled}
        draft={draft}
        mediaAssets={resolvedMedia}
        pinterestBoards={pinterestBoards}
        pinterestBoardsError={pinterestBoardsError}
        pinterestBoardsLoading={pinterestBoardsLoading}
        pinterestSections={pinterestSections}
        pinterestSectionsError={pinterestSectionsError}
        pinterestSectionsLoading={pinterestSectionsLoading}
        tiktokCreatorInfo={tiktokCreatorInfo}
        tiktokCreatorInfoError={tiktokCreatorInfoError}
        tiktokCreatorInfoLoading={tiktokCreatorInfoLoading ?? false}
        onLoadPinterestSections={onLoadPinterestSections}
        onRefreshPinterestBoards={onRefreshPinterestBoards}
        onRefreshTikTokCreatorInfo={onRefreshTikTokCreatorInfo}
        onChange={onChange}
      />
      <MediaSelector
        account={account}
        disabled={disabled || mediaLocked}
        draft={draft}
        mediaAssets={mediaAssets}
        onChange={onChange}
      />
    </div>
  );
}

function PlatformOptions({
  account,
  disabled,
  draft,
  mediaAssets,
  pinterestBoards,
  pinterestBoardsError,
  pinterestBoardsLoading,
  pinterestSections,
  pinterestSectionsError,
  pinterestSectionsLoading,
  tiktokCreatorInfo,
  tiktokCreatorInfoError,
  tiktokCreatorInfoLoading,
  onLoadPinterestSections,
  onRefreshPinterestBoards,
  onRefreshTikTokCreatorInfo,
  onChange,
}: {
  account: SocialAccountView;
  disabled: boolean;
  draft: PlatformOverrideDraft;
  mediaAssets: MediaAssetView[];
  pinterestBoards: PinterestBoardView[];
  pinterestBoardsError?: string;
  pinterestBoardsLoading: boolean;
  pinterestSections: PinterestBoardSectionView[];
  pinterestSectionsError?: string;
  pinterestSectionsLoading: boolean;
  tiktokCreatorInfo?: TikTokCreatorInfoView;
  tiktokCreatorInfoError?: string;
  tiktokCreatorInfoLoading: boolean;
  onLoadPinterestSections: (boardId: string) => void;
  onRefreshPinterestBoards: () => void;
  onRefreshTikTokCreatorInfo: () => void;
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
}) {
  if (account.platform === 'FACEBOOK') {
    return (
      <Field label="Kiểu bài Facebook">
        <SelectInput
          disabled={disabled}
          value={draft.facebookPostType}
          onChange={(event) =>
            onChange(account.id, {
              facebookPostType: event.target.value as PlatformOverrideDraft['facebookPostType'],
            })
          }
        >
          <option value="AUTO">Tự chọn theo media/link</option>
          <option value="TEXT_LINK">Text hoặc link</option>
          <option value="PHOTO">Ảnh</option>
          <option value="VIDEO">Video</option>
        </SelectInput>
      </Field>
    );
  }

  if (account.platform === 'INSTAGRAM') {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Vị trí Instagram">
          <SelectInput
            disabled={disabled}
            value={draft.instagramPlacement}
            onChange={(event) =>
              onChange(account.id, {
                instagramPlacement: event.target
                  .value as PlatformOverrideDraft['instagramPlacement'],
              })
            }
          >
            <option value="FEED">Feed</option>
            <option value="CAROUSEL">Carousel</option>
            <option value="REELS">Reels</option>
            <option value="STORY">Story</option>
          </SelectInput>
        </Field>
        <label className="flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700">
          <input
            checked={draft.instagramShareToFeed}
            disabled={disabled || draft.instagramPlacement !== 'REELS'}
            type="checkbox"
            onChange={(event) =>
              onChange(account.id, { instagramShareToFeed: event.target.checked })
            }
          />
          Share Reels lên feed
        </label>
      </div>
    );
  }

  if (account.platform === 'PINTEREST') {
    return (
      <PinterestOptionsPanel
        account={account}
        boards={pinterestBoards}
        boardsError={pinterestBoardsError}
        boardsLoading={pinterestBoardsLoading}
        disabled={disabled}
        draft={draft}
        sections={pinterestSections}
        sectionsError={pinterestSectionsError}
        sectionsLoading={pinterestSectionsLoading}
        onChange={onChange}
        onLoadSections={onLoadPinterestSections}
        onRefreshBoards={onRefreshPinterestBoards}
      />
    );
  }

  if (account.platform === 'YOUTUBE') {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Privacy">
          <SelectInput
            disabled={disabled}
            value={draft.youtubePrivacyStatus}
            onChange={(event) =>
              onChange(account.id, {
                youtubePrivacyStatus: event.target
                  .value as PlatformOverrideDraft['youtubePrivacyStatus'],
              })
            }
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </SelectInput>
        </Field>
        <Field label="Danh mục YouTube">
          <SelectInput
            disabled={disabled}
            value={draft.youtubeCategoryId}
            onChange={(event) => onChange(account.id, { youtubeCategoryId: event.target.value })}
          >
            {YOUTUBE_CATEGORIES.map((category) => (
              <option key={category.id} value={category.id}>
                {category.id} - {category.label}
              </option>
            ))}
          </SelectInput>
          <p className="mt-1 text-xs text-slate-500">
            Category ID là mã danh mục video của YouTube Data API. Mặc định 22 là People & Blogs.
          </p>
        </Field>
        <label className="flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700">
          <input
            checked={draft.youtubeMadeForKids}
            disabled={disabled}
            type="checkbox"
            onChange={(event) => onChange(account.id, { youtubeMadeForKids: event.target.checked })}
          />
          Made for kids
        </label>
        <label className="flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700">
          <input
            checked={draft.youtubeContainsSyntheticMedia}
            disabled={disabled}
            type="checkbox"
            onChange={(event) =>
              onChange(account.id, { youtubeContainsSyntheticMedia: event.target.checked })
            }
          />
          Có synthetic media
        </label>
      </div>
    );
  }

  if (account.platform === 'TIKTOK') {
    return (
      <TikTokOptionsPanel
        account={account}
        creatorInfo={tiktokCreatorInfo}
        creatorInfoError={tiktokCreatorInfoError}
        creatorInfoLoading={tiktokCreatorInfoLoading}
        disabled={disabled}
        draft={draft}
        mediaAssets={mediaAssets}
        onChange={onChange}
        onRefreshCreatorInfo={onRefreshTikTokCreatorInfo}
      />
    );
  }

  return null;
}

function PinterestOptionsPanel({
  account,
  boards,
  boardsError,
  boardsLoading,
  disabled,
  draft,
  sections,
  sectionsError,
  sectionsLoading,
  onChange,
  onLoadSections,
  onRefreshBoards,
}: {
  account: SocialAccountView;
  boards: PinterestBoardView[];
  boardsError?: string;
  boardsLoading: boolean;
  disabled: boolean;
  draft: PlatformOverrideDraft;
  sections: PinterestBoardSectionView[];
  sectionsError?: string;
  sectionsLoading: boolean;
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
  onLoadSections: (boardId: string) => void;
  onRefreshBoards: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-red-100 bg-red-50/50 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Board Pinterest">
          <SelectInput
            disabled={disabled || boardsLoading}
            value={draft.pinterestBoardId}
            onChange={(event) => {
              const boardId = event.target.value;
              onChange(account.id, { pinterestBoardId: boardId, pinterestBoardSectionId: '' });
              if (boardId) onLoadSections(boardId);
            }}
          >
            <option value="">
              {boardsLoading ? 'Đang tải board...' : 'Dùng board mặc định lúc kết nối'}
            </option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
                {board.privacy ? ` (${board.privacy})` : ''}
              </option>
            ))}
          </SelectInput>
          {boardsError ? (
            <p className="mt-1 text-xs text-red-700">{boardsError}</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Lấy board thật từ Pinterest bằng scope boards:read.
            </p>
          )}
        </Field>

        <Field label="Board section">
          <SelectInput
            disabled={disabled || !draft.pinterestBoardId || sectionsLoading}
            value={draft.pinterestBoardSectionId}
            onChange={(event) =>
              onChange(account.id, { pinterestBoardSectionId: event.target.value })
            }
            onFocus={() => {
              if (draft.pinterestBoardId && sections.length === 0 && !sectionsLoading) {
                onLoadSections(draft.pinterestBoardId);
              }
            }}
          >
            <option value="">
              {!draft.pinterestBoardId
                ? 'Chọn board trước'
                : sectionsLoading
                  ? 'Đang tải section...'
                  : 'Không dùng section'}
            </option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
              </option>
            ))}
          </SelectInput>
          {sectionsError ? (
            <p className="mt-1 text-xs text-red-700">{sectionsError}</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">Section là thư mục con trong board.</p>
          )}
        </Field>

        <Field label="Alt text ảnh Pinterest">
          <TextInput
            disabled={disabled}
            placeholder="Mô tả ảnh ngắn gọn, chứa từ khóa tự nhiên"
            value={draft.pinterestAltText}
            onChange={(event) => onChange(account.id, { pinterestAltText: event.target.value })}
          />
          <p className="mt-1 text-xs text-slate-500">
            Gửi lên Pinterest dưới dạng alt_text cho SEO/accessibility. Đổi tên media dùng nút riêng
            trong Storage.
          </p>
        </Field>

        <Field label="AI disclosure">
          <SelectInput
            disabled={disabled}
            value={draft.pinterestAiDisclosure}
            onChange={(event) =>
              onChange(account.id, {
                pinterestAiDisclosure: event.target
                  .value as PlatformOverrideDraft['pinterestAiDisclosure'],
              })
            }
          >
            <option value="NONE">Không khai báo AI</option>
            <option value="GENERATIVE_AI">Có nội dung AI-generated</option>
          </SelectInput>
        </Field>
      </div>

      <button
        className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
        disabled={disabled || boardsLoading}
        type="button"
        onClick={onRefreshBoards}
      >
        <RefreshCw className={`h-4 w-4 ${boardsLoading ? 'animate-spin' : ''}`} />
        Làm mới board
      </button>
    </div>
  );
}

function TikTokOptionsPanel({
  account,
  creatorInfo,
  creatorInfoError,
  creatorInfoLoading,
  disabled,
  draft,
  mediaAssets,
  onChange,
  onRefreshCreatorInfo,
}: {
  account: SocialAccountView;
  creatorInfo?: TikTokCreatorInfoView;
  creatorInfoError?: string;
  creatorInfoLoading: boolean;
  disabled: boolean;
  draft: PlatformOverrideDraft;
  mediaAssets: MediaAssetView[];
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
  onRefreshCreatorInfo: () => void;
}) {
  const directPost = draft.tiktokPostMode === 'DIRECT_POST';
  const videos = mediaAssets.filter((asset) => asset.type === 'VIDEO');
  const images = mediaAssets.filter((asset) => asset.type === 'IMAGE');
  const firstVideo = videos[0];
  const privacyOptions = creatorInfo?.privacyLevelOptions ?? [];
  const selectedPrivacy = privacyOptions.includes(draft.tiktokPrivacyLevel)
    ? draft.tiktokPrivacyLevel
    : '';
  const durationTooLong =
    Boolean(firstVideo?.durationSec && creatorInfo?.maxVideoPostDurationSec) &&
    Number(firstVideo?.durationSec) > Number(creatorInfo?.maxVideoPostDurationSec);
  const brandedPrivateConflict =
    directPost && draft.tiktokBrandContent && draft.tiktokPrivacyLevel === 'SELF_ONLY';

  return (
    <div className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {creatorInfo?.creatorAvatarUrl ? (
            <img
              alt=""
              className="h-10 w-10 rounded-full border border-slate-200 object-cover"
              src={creatorInfo.creatorAvatarUrl}
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-500">
              TT
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-950">
              {creatorInfo?.creatorNickname || account.name}
            </p>
            <p className="truncate text-xs text-slate-500">
              {creatorInfo?.creatorUsername
                ? `@${creatorInfo.creatorUsername}`
                : (account.username ?? account.id)}
            </p>
          </div>
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-wait disabled:opacity-60"
          disabled={disabled || creatorInfoLoading}
          type="button"
          onClick={onRefreshCreatorInfo}
        >
          <RefreshCw className={`h-4 w-4 ${creatorInfoLoading ? 'animate-spin' : ''}`} />
          Creator settings
        </button>
      </div>

      {creatorInfo ? (
        <div className="grid gap-2 text-xs text-slate-600 md:grid-cols-4">
          <InheritedChip label="Privacy options" value={`${privacyOptions.length} lựa chọn`} />
          <InheritedChip
            label="Max video"
            value={formatSeconds(creatorInfo.maxVideoPostDurationSec)}
          />
          <InheritedChip label="Interactions" value={tiktokInteractionSummary(creatorInfo)} />
          <InheritedChip label="Fetched" value={formatShortDate(creatorInfo.fetchedAt)} />
        </div>
      ) : null}

      {creatorInfoError ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {creatorInfoError}
        </div>
      ) : null}

      {directPost && !creatorInfo && !creatorInfoError ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Direct Post cần tải creator settings từ TikTok trước khi publish.
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Publish mode">
          <SelectInput
            disabled={disabled}
            value={draft.tiktokPostMode}
            onChange={(event) => {
              const tiktokPostMode = event.target.value as PlatformOverrideDraft['tiktokPostMode'];
              onChange(
                account.id,
                tiktokPostMode === 'DIRECT_POST'
                  ? { tiktokPostMode }
                  : {
                      tiktokPostMode,
                      tiktokPrivacyLevel: '',
                      tiktokCoverTimestampMs: '',
                      tiktokPhotoCoverIndex: '',
                      tiktokAutoAddMusic: false,
                      tiktokConsentConfirmed: false,
                      tiktokCommercialContent: false,
                      tiktokBrandContent: false,
                      tiktokBrandOrganic: false,
                      tiktokIsAiGenerated: false,
                    },
              );
            }}
          >
            <option value="DIRECT_POST">Direct post</option>
            <option value="MEDIA_UPLOAD">Send to user inbox</option>
          </SelectInput>
        </Field>

        <Field label="Privacy TikTok">
          <SelectInput
            disabled={disabled || !directPost || !creatorInfo}
            value={selectedPrivacy}
            onChange={(event) =>
              onChange(account.id, {
                tiktokPrivacyLevel: event.target
                  .value as PlatformOverrideDraft['tiktokPrivacyLevel'],
              })
            }
          >
            <option value="">Chọn privacy từ TikTok</option>
            {privacyOptions.map((privacy) => (
              <option key={privacy} value={privacy}>
                {tiktokPrivacyLabel(privacy)}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      {directPost ? (
        <div className="grid gap-3 md:grid-cols-3">
          <SwitchRow
            checked={!draft.tiktokDisableComment && !creatorInfo?.commentDisabled}
            disabled={disabled || creatorInfo?.commentDisabled === true}
            label={creatorInfo?.commentDisabled ? 'Comment bị tắt trên TikTok' : 'Cho phép comment'}
            onChange={(checked) => onChange(account.id, { tiktokDisableComment: !checked })}
          />
          <SwitchRow
            checked={!draft.tiktokDisableDuet && !creatorInfo?.duetDisabled}
            disabled={disabled || images.length > 0 || creatorInfo?.duetDisabled === true}
            label={creatorInfo?.duetDisabled ? 'Duet bị tắt trên TikTok' : 'Cho phép duet'}
            onChange={(checked) => onChange(account.id, { tiktokDisableDuet: !checked })}
          />
          <SwitchRow
            checked={!draft.tiktokDisableStitch && !creatorInfo?.stitchDisabled}
            disabled={disabled || images.length > 0 || creatorInfo?.stitchDisabled === true}
            label={creatorInfo?.stitchDisabled ? 'Stitch bị tắt trên TikTok' : 'Cho phép stitch'}
            onChange={(checked) => onChange(account.id, { tiktokDisableStitch: !checked })}
          />
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
          Send to user inbox chỉ upload video vào TikTok app. Người dùng mở TikTok để chỉnh sửa và
          đăng.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Field label={videos.length > 0 ? 'Cover timestamp ms' : 'Photo cover index'}>
          <TextInput
            disabled={disabled || !directPost}
            inputMode="numeric"
            placeholder={videos.length > 0 ? 'Ví dụ 1500' : '0'}
            value={videos.length > 0 ? draft.tiktokCoverTimestampMs : draft.tiktokPhotoCoverIndex}
            onChange={(event) =>
              onChange(
                account.id,
                videos.length > 0
                  ? { tiktokCoverTimestampMs: event.target.value.replace(/\D/g, '') }
                  : { tiktokPhotoCoverIndex: event.target.value.replace(/\D/g, '') },
              )
            }
          />
        </Field>
        <SwitchRow
          checked={draft.tiktokIsAiGenerated}
          disabled={disabled || !directPost}
          label="Nội dung có AI-generated"
          onChange={(checked) => onChange(account.id, { tiktokIsAiGenerated: checked })}
        />
      </div>

      {directPost && images.length > 0 ? (
        <SwitchRow
          checked={draft.tiktokAutoAddMusic}
          disabled={disabled}
          label="TikTok tự thêm nhạc cho photo post"
          onChange={(checked) => onChange(account.id, { tiktokAutoAddMusic: checked })}
        />
      ) : null}

      {directPost ? (
        <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
          <SwitchRow
            checked={draft.tiktokCommercialContent}
            disabled={disabled}
            label="Có nội dung thương mại"
            onChange={(checked) =>
              onChange(account.id, {
                tiktokCommercialContent: checked,
                tiktokBrandContent: checked ? draft.tiktokBrandContent : false,
                tiktokBrandOrganic: checked ? draft.tiktokBrandOrganic : false,
              })
            }
          />
          {draft.tiktokCommercialContent ? (
            <div className="grid gap-3 md:grid-cols-2">
              <SwitchRow
                checked={draft.tiktokBrandOrganic}
                disabled={disabled}
                label="Your brand"
                onChange={(checked) => onChange(account.id, { tiktokBrandOrganic: checked })}
              />
              <SwitchRow
                checked={draft.tiktokBrandContent}
                disabled={disabled}
                label="Branded content"
                onChange={(checked) => onChange(account.id, { tiktokBrandContent: checked })}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {durationTooLong ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Video dài {formatSeconds(firstVideo?.durationSec)} vượt giới hạn TikTok hiện tại{' '}
          {formatSeconds(creatorInfo?.maxVideoPostDurationSec)}.
        </div>
      ) : null}

      {brandedPrivateConflict ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Branded content không được đăng ở privacy Only me.
        </div>
      ) : null}

      {directPost ? (
        <SwitchRow
          checked={draft.tiktokConsentConfirmed}
          disabled={disabled}
          label="Tôi đồng ý TikTok Music Usage Confirmation trước khi đăng"
          onChange={(checked) => onChange(account.id, { tiktokConsentConfirmed: checked })}
        />
      ) : null}

      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
        <p className="font-semibold text-slate-900">Media preview</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {mediaAssets.length > 0 ? (
            mediaAssets.map((asset) => (
              <div key={asset.id} className="rounded-md bg-slate-50 px-3 py-2">
                <p className="truncate font-medium">{asset.originalFileName ?? asset.id}</p>
                <p className="text-xs text-slate-500">
                  {asset.mimeType ?? asset.type} · {formatBytes(asset.sizeBytes)}
                  {asset.durationSec ? ` · ${formatSeconds(asset.durationSec)}` : ''}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-500">Chưa có media cho target TikTok.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MediaSelector({
  account,
  disabled,
  draft,
  mediaAssets,
  onChange,
}: {
  account: SocialAccountView;
  disabled: boolean;
  draft: PlatformOverrideDraft;
  mediaAssets: MediaAssetView[];
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
}) {
  if (mediaAssets.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500">
        Chưa có media chung. Social nào cần ảnh/video sẽ chưa publish được.
      </p>
    );
  }

  return (
    <div>
      <p className="text-sm font-medium text-slate-800">Media riêng cho target này</p>
      <p className="mt-1 text-xs text-slate-500">
        Không chọn thì dùng toàn bộ media chung. Với YouTube/TikTok nên chọn đúng 1 video.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {mediaAssets.map((asset) => (
          <label
            key={asset.id}
            className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <input
              checked={draft.mediaAssetIds.includes(asset.id)}
              className="mt-1"
              disabled={disabled}
              type="checkbox"
              onChange={() =>
                onChange(account.id, {
                  mediaAssetIds: draft.mediaAssetIds.includes(asset.id)
                    ? draft.mediaAssetIds.filter((id) => id !== asset.id)
                    : [...draft.mediaAssetIds, asset.id],
                })
              }
            />
            <span className="min-w-0">
              <span className="block truncate font-medium text-slate-900">
                {asset.originalFileName ?? asset.id}
              </span>
              <span className="block text-xs text-slate-500">
                {asset.mimeType ?? asset.type} · {asset.status}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SwitchRow({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700">
      <input
        checked={checked}
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

const YOUTUBE_CATEGORIES = [
  { id: '1', label: 'Film & Animation' },
  { id: '2', label: 'Autos & Vehicles' },
  { id: '10', label: 'Music' },
  { id: '15', label: 'Pets & Animals' },
  { id: '17', label: 'Sports' },
  { id: '19', label: 'Travel & Events' },
  { id: '20', label: 'Gaming' },
  { id: '22', label: 'People & Blogs' },
  { id: '23', label: 'Comedy' },
  { id: '24', label: 'Entertainment' },
  { id: '25', label: 'News & Politics' },
  { id: '26', label: 'Howto & Style' },
  { id: '27', label: 'Education' },
  { id: '28', label: 'Science & Technology' },
  { id: '29', label: 'Nonprofits & Activism' },
] as const;

function pinterestSectionKey(accountId: string, boardId: string): string {
  return `${accountId}:${boardId}`;
}

function platformPanelTone(platform: Platform): {
  article: string;
  header: string;
  badge: string;
} {
  switch (platform) {
    case 'FACEBOOK':
      return {
        article: 'border-blue-200',
        header: 'bg-blue-50/70',
        badge: 'bg-blue-100 text-blue-700',
      };
    case 'INSTAGRAM':
      return {
        article: 'border-fuchsia-200',
        header: 'bg-fuchsia-50/70',
        badge: 'bg-fuchsia-100 text-fuchsia-700',
      };
    case 'PINTEREST':
      return {
        article: 'border-red-200',
        header: 'bg-red-50/70',
        badge: 'bg-red-100 text-red-700',
      };
    case 'YOUTUBE':
      return {
        article: 'border-amber-200',
        header: 'bg-amber-50/70',
        badge: 'bg-amber-100 text-amber-800',
      };
    case 'TIKTOK':
      return {
        article: 'border-cyan-200',
        header: 'bg-cyan-50/70',
        badge: 'bg-cyan-100 text-cyan-700',
      };
    default:
      return {
        article: 'border-slate-200',
        header: 'bg-white',
        badge: 'bg-slate-100 text-slate-600',
      };
  }
}

function tiktokPrivacyLabel(value: string): string {
  switch (value) {
    case 'PUBLIC_TO_EVERYONE':
      return 'Public';
    case 'MUTUAL_FOLLOW_FRIENDS':
      return 'Friends';
    case 'FOLLOWER_OF_CREATOR':
      return 'Followers';
    case 'SELF_ONLY':
      return 'Only me';
    default:
      return value;
  }
}

function tiktokInteractionSummary(creatorInfo: TikTokCreatorInfoView): string {
  const disabled = [
    creatorInfo.commentDisabled ? 'comment' : null,
    creatorInfo.duetDisabled ? 'duet' : null,
    creatorInfo.stitchDisabled ? 'stitch' : null,
  ].filter(Boolean);
  return disabled.length > 0 ? `Tắt ${disabled.join(', ')}` : 'Đều có thể bật';
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(value));
}

function formatSeconds(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '-';
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatBytes(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '-';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function platformChecklist(platform: Platform, media: MediaAssetView[]): string[] {
  const imageCount = media.filter((asset) => asset.type === 'IMAGE').length;
  const videoCount = media.filter((asset) => asset.type === 'VIDEO').length;

  if (platform === 'FACEBOOK') {
    if (imageCount > 0 && videoCount > 0) return ['Không trộn ảnh và video trong một post'];
    if (videoCount > 1) return ['Chỉ hỗ trợ 1 video'];
  }

  if (platform === 'INSTAGRAM') {
    if (media.length === 0) return ['Cần ảnh hoặc video'];
    if (media.length > 10) return ['Tối đa 10 media'];
    if (media.some((asset) => !asset.readUrl?.startsWith('http'))) {
      return ['Media phải có URL public để Meta tải được'];
    }
  }

  if (platform === 'PINTEREST') {
    const imagePin = imageCount === 1 && videoCount === 0 && media.length === 1;
    const videoPin = videoCount === 1 && imageCount <= 1 && media.length <= 2;
    if (!imagePin && !videoPin) return ['Cần 1 ảnh, hoặc 1 video + tối đa 1 ảnh cover'];
  }

  if (platform === 'YOUTUBE') {
    if (videoCount !== 1 || imageCount > 0 || media.length !== 1) {
      return ['Cần đúng 1 video, không kèm ảnh'];
    }
  }

  if (platform === 'TIKTOK') {
    if (videoCount > 0 && (videoCount !== 1 || imageCount > 0 || media.length !== 1)) {
      return ['Video: cần đúng 1 video'];
    }
    if (imageCount > 0 && videoCount > 0) {
      return ['Không trộn ảnh và video'];
    }
    if (imageCount > 35) {
      return ['Ảnh: tối đa 35 ảnh'];
    }
    if (imageCount > 0 && media.some((asset) => !asset.readUrl?.startsWith('https://'))) {
      return ['Ảnh TikTok cần URL HTTPS public đã verify'];
    }
    if (videoCount === 0 && imageCount === 0) {
      return ['Cần 1 video hoặc 1-35 ảnh'];
    }
  }

  return [];
}

function resolveMedia(
  draft: PlatformOverrideDraft,
  mediaAssets: MediaAssetView[],
): MediaAssetView[] {
  if (!draft.customized || draft.mediaAssetIds.length === 0) return mediaAssets;
  return mediaAssets.filter((asset) => draft.mediaAssetIds.includes(asset.id));
}

function commonTextSummary(common: PlatformComposerPanelsProps['common']): string {
  if (!common) return 'Theo nội dung chung';
  const parts = [
    common.title?.trim() ? 'tiêu đề' : null,
    common.body?.trim() ? 'nội dung' : null,
    common.linkUrl?.trim() ? 'link' : null,
    common.hashtags?.trim() ? 'hashtag' : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Dùng ${parts.join(' + ')}` : 'Chưa có text chung';
}

function mediaSummary(mediaAssets: MediaAssetView[]): string {
  if (mediaAssets.length === 0) return 'Chưa có media';
  const imageCount = mediaAssets.filter((asset) => asset.type === 'IMAGE').length;
  const videoCount = mediaAssets.filter((asset) => asset.type === 'VIDEO').length;
  return [
    imageCount > 0 ? `${imageCount} ảnh` : null,
    videoCount > 0 ? `${videoCount} video` : null,
  ]
    .filter(Boolean)
    .join(' + ');
}

function platformModeHint(platform: Platform): string {
  if (platform === 'YOUTUBE') return 'Title/description chung + tags metadata';
  if (platform === 'TIKTOK') return 'Caption chung + hashtag trong caption';
  if (platform === 'PINTEREST') return 'Title/link/description chung';
  if (platform === 'INSTAGRAM') return 'Caption chung + hashtag trong caption';
  return 'Kế thừa nội dung chung';
}

function titleLabel(platform: Platform): string | null {
  if (platform === 'YOUTUBE') return 'Tiêu đề video';
  if (platform === 'PINTEREST') return 'Pin title';
  if (platform === 'FACEBOOK') return 'Title video Facebook';
  return null;
}

function titlePlaceholder(platform: Platform): string {
  if (platform === 'YOUTUBE') return 'Bắt buộc khi đăng YouTube';
  if (platform === 'PINTEREST') return 'Tối đa 100 ký tự';
  return 'Tùy chọn';
}

function captionLabel(platform: Platform): string | null {
  if (platform === 'FACEBOOK') return 'Message Facebook';
  if (platform === 'INSTAGRAM') return 'Caption Instagram';
  if (platform === 'TIKTOK') return 'Caption TikTok';
  return null;
}

function descriptionLabel(platform: Platform): string | null {
  if (platform === 'YOUTUBE') return 'Description YouTube';
  if (platform === 'PINTEREST') return 'Pin description';
  return null;
}

function linkLabel(platform: Platform): string | null {
  if (platform === 'FACEBOOK') return 'Link Facebook';
  if (platform === 'PINTEREST') return 'Destination link';
  return null;
}
