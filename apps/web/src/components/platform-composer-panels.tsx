import { PLATFORM_LABELS } from '@socialhub/shared';
import type { Platform } from '@socialhub/shared';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Field, SelectInput, TextInput } from '@/components/form-controls';
import {
  platformOverrideDefaults,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import type { MediaAssetView, SocialAccountView } from '@/lib/types';

interface PlatformComposerPanelsProps {
  accounts: SocialAccountView[];
  mediaAssets: MediaAssetView[];
  drafts: Record<string, PlatformOverrideDraft>;
  disabled?: boolean;
  mediaLocked?: boolean;
  common?: {
    title?: string;
    body?: string;
    linkUrl?: string;
  };
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
}

export function PlatformComposerPanels({
  accounts,
  mediaAssets,
  drafts,
  disabled = false,
  mediaLocked = false,
  common,
  onChange,
}: PlatformComposerPanelsProps) {
  const [expandedAccountIds, setExpandedAccountIds] = useState<string[]>([]);
  if (accounts.length === 0) return null;

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
            Chọn Tùy chỉnh khi target này cần caption, link, media hoặc option khác nội dung chung.
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
          return (
            <article
              key={account.id}
              className="overflow-hidden rounded-md border border-slate-200 bg-white"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-950">{account.name}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
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
                      onChange={onChange}
                    />
                  ) : (
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                      Target này đang lấy tiêu đề, nội dung, link và media từ phần nội dung chung.
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
  onChange,
}: {
  account: SocialAccountView;
  disabled: boolean;
  draft: PlatformOverrideDraft;
  mediaLocked: boolean;
  mediaAssets: MediaAssetView[];
  onChange: (accountId: string, patch: Partial<PlatformOverrideDraft>) => void;
}) {
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

      <PlatformOptions account={account} disabled={disabled} draft={draft} onChange={onChange} />
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
  onChange,
}: {
  account: SocialAccountView;
  disabled: boolean;
  draft: PlatformOverrideDraft;
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
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Board ID">
          <TextInput
            disabled={disabled}
            placeholder="Để trống dùng board khi kết nối"
            value={draft.pinterestBoardId}
            onChange={(event) => onChange(account.id, { pinterestBoardId: event.target.value })}
          />
        </Field>
        <Field label="Board section ID">
          <TextInput
            disabled={disabled}
            placeholder="Tùy chọn"
            value={draft.pinterestBoardSectionId}
            onChange={(event) =>
              onChange(account.id, { pinterestBoardSectionId: event.target.value })
            }
          />
        </Field>
        <Field label="Alt text ảnh">
          <TextInput
            disabled={disabled}
            placeholder="Mô tả ảnh cho accessibility"
            value={draft.pinterestAltText}
            onChange={(event) => onChange(account.id, { pinterestAltText: event.target.value })}
          />
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
        <Field label="Category ID">
          <TextInput
            disabled={disabled}
            placeholder="22 = People & Blogs"
            value={draft.youtubeCategoryId}
            onChange={(event) => onChange(account.id, { youtubeCategoryId: event.target.value })}
          />
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
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Publish mode">
          <SelectInput
            disabled={disabled}
            value={draft.tiktokPostMode}
            onChange={(event) =>
              onChange(account.id, {
                tiktokPostMode: event.target.value as PlatformOverrideDraft['tiktokPostMode'],
              })
            }
          >
            <option value="DIRECT_POST">Direct post</option>
            <option value="MEDIA_UPLOAD">Upload to TikTok Inbox</option>
          </SelectInput>
        </Field>
        <Field label="Privacy TikTok">
          <SelectInput
            disabled={disabled || draft.tiktokPostMode !== 'DIRECT_POST'}
            value={draft.tiktokPrivacyLevel}
            onChange={(event) =>
              onChange(account.id, {
                tiktokPrivacyLevel: event.target
                  .value as PlatformOverrideDraft['tiktokPrivacyLevel'],
              })
            }
          >
            <option value="PUBLIC_TO_EVERYONE">Public</option>
            <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
            <option value="FOLLOWER_OF_CREATOR">Followers</option>
            <option value="SELF_ONLY">Only me</option>
          </SelectInput>
        </Field>
        <Field label="Cover timestamp ms">
          <TextInput
            disabled={disabled}
            inputMode="numeric"
            placeholder="Ví dụ 1500"
            value={draft.tiktokCoverTimestampMs}
            onChange={(event) =>
              onChange(account.id, {
                tiktokCoverTimestampMs: event.target.value.replace(/\D/g, ''),
              })
            }
          />
        </Field>
        <Field label="Photo cover index">
          <TextInput
            disabled={disabled}
            inputMode="numeric"
            placeholder="0"
            value={draft.tiktokPhotoCoverIndex}
            onChange={(event) =>
              onChange(account.id, {
                tiktokPhotoCoverIndex: event.target.value.replace(/\D/g, ''),
              })
            }
          />
        </Field>
        <SwitchRow
          checked={draft.tiktokDisableComment}
          disabled={disabled || draft.tiktokPostMode !== 'DIRECT_POST'}
          label="Tắt comment"
          onChange={(checked) => onChange(account.id, { tiktokDisableComment: checked })}
        />
        <SwitchRow
          checked={draft.tiktokDisableDuet}
          disabled={disabled}
          label="Tắt duet"
          onChange={(checked) => onChange(account.id, { tiktokDisableDuet: checked })}
        />
        <SwitchRow
          checked={draft.tiktokDisableStitch}
          disabled={disabled}
          label="Tắt stitch"
          onChange={(checked) => onChange(account.id, { tiktokDisableStitch: checked })}
        />
        <SwitchRow
          checked={draft.tiktokAutoAddMusic}
          disabled={disabled || draft.tiktokPostMode !== 'DIRECT_POST'}
          label="Auto add music cho ảnh"
          onChange={(checked) => onChange(account.id, { tiktokAutoAddMusic: checked })}
        />
      </div>
    );
  }

  return null;
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
  if (platform === 'YOUTUBE') return 'Dùng title + 1 video chung';
  if (platform === 'TIKTOK') return 'Mặc định gửi vào TikTok Inbox';
  if (platform === 'PINTEREST') return 'Dùng title/link/media chung';
  if (platform === 'INSTAGRAM') return 'Dùng caption/media chung';
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
