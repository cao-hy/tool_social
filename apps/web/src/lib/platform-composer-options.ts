import type { Platform } from '@socialhub/shared';

export interface PlatformOverrideDraft {
  customized: boolean;
  title: string;
  caption: string;
  description: string;
  linkUrl: string;
  mediaAssetIds: string[];
  facebookPostType: 'AUTO' | 'TEXT_LINK' | 'PHOTO' | 'VIDEO';
  instagramPlacement: 'FEED' | 'CAROUSEL' | 'REELS' | 'STORY';
  instagramShareToFeed: boolean;
  pinterestBoardId: string;
  pinterestBoardSectionId: string;
  pinterestAltText: string;
  pinterestDominantColor: string;
  pinterestAiDisclosure: 'NONE' | 'GENERATIVE_AI';
  youtubePrivacyStatus: 'public' | 'unlisted' | 'private';
  youtubeCategoryId: string;
  youtubeMadeForKids: boolean;
  youtubeContainsSyntheticMedia: boolean;
  tiktokPostMode: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  tiktokPrivacyLevel:
    '' | 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  tiktokDisableComment: boolean;
  tiktokDisableDuet: boolean;
  tiktokDisableStitch: boolean;
  tiktokCoverTimestampMs: string;
  tiktokAutoAddMusic: boolean;
  tiktokPhotoCoverIndex: string;
  tiktokConsentConfirmed: boolean;
  tiktokCommercialContent: boolean;
  tiktokBrandContent: boolean;
  tiktokBrandOrganic: boolean;
  tiktokIsAiGenerated: boolean;
}

export const EMPTY_PLATFORM_OVERRIDE: PlatformOverrideDraft = {
  customized: false,
  title: '',
  caption: '',
  description: '',
  linkUrl: '',
  mediaAssetIds: [],
  facebookPostType: 'AUTO',
  instagramPlacement: 'FEED',
  instagramShareToFeed: false,
  pinterestBoardId: '',
  pinterestBoardSectionId: '',
  pinterestAltText: '',
  pinterestDominantColor: '',
  pinterestAiDisclosure: 'NONE',
  youtubePrivacyStatus: 'public',
  youtubeCategoryId: '22',
  youtubeMadeForKids: false,
  youtubeContainsSyntheticMedia: false,
  tiktokPostMode: 'MEDIA_UPLOAD',
  tiktokPrivacyLevel: '',
  tiktokDisableComment: true,
  tiktokDisableDuet: true,
  tiktokDisableStitch: true,
  tiktokCoverTimestampMs: '',
  tiktokAutoAddMusic: false,
  tiktokPhotoCoverIndex: '',
  tiktokConsentConfirmed: false,
  tiktokCommercialContent: false,
  tiktokBrandContent: false,
  tiktokBrandOrganic: false,
  tiktokIsAiGenerated: false,
};

export function platformOverrideDefaults(platform: Platform, scopes: string[] = []) {
  const canDirectPostTikTok = platform === 'TIKTOK' && scopes.includes('video.publish');
  return {
    ...EMPTY_PLATFORM_OVERRIDE,
    customized: canDirectPostTikTok,
    tiktokPostMode: canDirectPostTikTok ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
  } satisfies PlatformOverrideDraft;
}

export function platformOverrideFromOptions(input: {
  title?: string | null;
  caption?: string | null;
  description?: string | null;
  linkUrl?: string | null;
  mediaAssetIds?: string[];
  options?: Record<string, unknown> | null;
}): PlatformOverrideDraft {
  const options = input.options ?? {};
  const hasOptions = Object.keys(options).length > 0;
  const hasContentOverride = Boolean(
    input.title ||
    input.caption ||
    input.description ||
    input.linkUrl ||
    input.mediaAssetIds?.length,
  );
  return {
    ...EMPTY_PLATFORM_OVERRIDE,
    customized: hasContentOverride || hasOptions,
    title: input.title ?? '',
    caption: input.caption ?? '',
    description: input.description ?? '',
    linkUrl: input.linkUrl ?? '',
    mediaAssetIds: input.mediaAssetIds ?? [],
    facebookPostType: readEnum(options.postType, ['AUTO', 'TEXT_LINK', 'PHOTO', 'VIDEO'], 'AUTO'),
    instagramPlacement: readEnum(options.mediaType, ['FEED', 'CAROUSEL', 'REELS', 'STORY'], 'FEED'),
    instagramShareToFeed: readBoolean(options.shareToFeed, false),
    pinterestBoardId: readString(options.boardId),
    pinterestBoardSectionId: readString(options.boardSectionId),
    pinterestAltText: readString(options.altText),
    pinterestDominantColor: readString(options.dominantColor),
    pinterestAiDisclosure:
      Array.isArray(options.aiDisclosures) && options.aiDisclosures.length > 0
        ? 'GENERATIVE_AI'
        : 'NONE',
    youtubePrivacyStatus: readEnum(
      options.privacyStatus,
      ['public', 'unlisted', 'private'],
      'public',
    ),
    youtubeCategoryId: readString(options.categoryId) || '22',
    youtubeMadeForKids: readBoolean(options.selfDeclaredMadeForKids, false),
    youtubeContainsSyntheticMedia: readBoolean(options.containsSyntheticMedia, false),
    tiktokPostMode: readEnum(options.postMode, ['DIRECT_POST', 'MEDIA_UPLOAD'], 'MEDIA_UPLOAD'),
    tiktokPrivacyLevel: readEnum(
      options.privacyLevel,
      ['', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
      '',
    ),
    tiktokDisableComment: readBoolean(options.disableComment, true),
    tiktokDisableDuet: readBoolean(options.disableDuet, true),
    tiktokDisableStitch: readBoolean(options.disableStitch, true),
    tiktokCoverTimestampMs:
      typeof options.videoCoverTimestampMs === 'number'
        ? String(options.videoCoverTimestampMs)
        : '',
    tiktokAutoAddMusic: readBoolean(options.autoAddMusic, false),
    tiktokPhotoCoverIndex:
      typeof options.photoCoverIndex === 'number' ? String(options.photoCoverIndex) : '',
    tiktokConsentConfirmed: readBoolean(options.consentConfirmed, false),
    tiktokCommercialContent: readBoolean(options.commercialContentEnabled, false),
    tiktokBrandContent: readBoolean(options.brandContentToggle, false),
    tiktokBrandOrganic: readBoolean(options.brandOrganicToggle, false),
    tiktokIsAiGenerated: readBoolean(options.isAiGenerated, false),
  };
}

export function platformOptions(platform: Platform, draft: PlatformOverrideDraft) {
  if (!draft.customized) return undefined;

  switch (platform) {
    case 'FACEBOOK':
      return compactOptions({
        postType: draft.facebookPostType === 'AUTO' ? undefined : draft.facebookPostType,
      });
    case 'INSTAGRAM':
      return compactOptions({
        mediaType: draft.instagramPlacement,
        shareToFeed: draft.instagramPlacement === 'REELS' ? draft.instagramShareToFeed : undefined,
      });
    case 'PINTEREST':
      return compactOptions({
        boardId: draft.pinterestBoardId.trim() || undefined,
        boardSectionId: draft.pinterestBoardSectionId.trim() || undefined,
        altText: draft.pinterestAltText.trim() || undefined,
        dominantColor: draft.pinterestDominantColor.trim() || undefined,
        aiDisclosures:
          draft.pinterestAiDisclosure === 'GENERATIVE_AI' ? ['GENERATIVE_AI'] : undefined,
      });
    case 'YOUTUBE':
      return compactOptions({
        privacyStatus: draft.youtubePrivacyStatus,
        categoryId: draft.youtubeCategoryId.trim() || '22',
        selfDeclaredMadeForKids: draft.youtubeMadeForKids,
        containsSyntheticMedia: draft.youtubeContainsSyntheticMedia,
      });
    case 'TIKTOK':
      return compactOptions({
        postMode: draft.tiktokPostMode,
        privacyLevel: draft.tiktokPrivacyLevel,
        disableComment: draft.tiktokDisableComment,
        disableDuet: draft.tiktokDisableDuet,
        disableStitch: draft.tiktokDisableStitch,
        videoCoverTimestampMs: draft.tiktokCoverTimestampMs
          ? Number(draft.tiktokCoverTimestampMs)
          : undefined,
        autoAddMusic: draft.tiktokAutoAddMusic,
        photoCoverIndex: draft.tiktokPhotoCoverIndex
          ? Number(draft.tiktokPhotoCoverIndex)
          : undefined,
        consentConfirmed: draft.tiktokConsentConfirmed,
        commercialContentEnabled: draft.tiktokCommercialContent,
        brandContentToggle: draft.tiktokCommercialContent ? draft.tiktokBrandContent : undefined,
        brandOrganicToggle: draft.tiktokCommercialContent ? draft.tiktokBrandOrganic : undefined,
        isAiGenerated: draft.tiktokIsAiGenerated,
      });
    default:
      return undefined;
  }
}

export function hasPlatformSpecificOptions(
  platform: Platform,
  draft: PlatformOverrideDraft,
): boolean {
  return Boolean(platformOptions(platform, draft));
}

export function isPlatformOverrideActive(
  platform: Platform,
  draft: PlatformOverrideDraft,
): boolean {
  if (!draft.customized) return false;
  return Boolean(
    draft.title.trim() ||
    draft.caption.trim() ||
    draft.description.trim() ||
    draft.linkUrl.trim() ||
    draft.mediaAssetIds.length > 0 ||
    hasPlatformSpecificOptions(platform, draft),
  );
}

function compactOptions(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readEnum<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}
