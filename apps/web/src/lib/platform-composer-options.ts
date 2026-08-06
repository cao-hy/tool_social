import type { Platform } from '@socialhub/shared';

export interface PlatformOverrideDraft {
  customized: boolean;
  title: string;
  caption: string;
  description: string;
  linkUrl: string;
  mediaAssetIds: string[];
  facebookPostType: 'AUTO' | 'TEXT_LINK' | 'PHOTO' | 'VIDEO';
  facebookPlaceId: string;
  facebookPhotoAltText: string;
  facebookVideoTitle: string;
  instagramPlacement: 'FEED' | 'CAROUSEL' | 'REELS' | 'STORY';
  instagramShareToFeed: boolean;
  instagramLocationId: string;
  instagramAltText: string;
  instagramCollaborators: string;
  instagramUserTagsJson: string;
  pinterestBoardId: string;
  pinterestBoardSectionId: string;
  pinterestAltText: string;
  pinterestDominantColor: string;
  pinterestAiDisclosure: 'NONE' | 'GENERATIVE_AI';
  pinterestIsStandard: boolean;
  pinterestAdAccountId: string;
  pinterestProductTagsJson: string;
  thumbnailMode: 'AUTO' | 'GENERATED' | 'MEDIA_ASSET' | 'VIDEO_FRAME';
  thumbnailMediaAssetId: string;
  youtubePrivacyStatus: 'public' | 'unlisted' | 'private';
  youtubeCategoryId: string;
  youtubeTags: string;
  youtubeNotifySubscribers: boolean;
  youtubeLicense: 'youtube' | 'creativeCommon';
  youtubeEmbeddable: boolean;
  youtubePublicStatsViewable: boolean;
  youtubeDefaultLanguage: string;
  youtubeDefaultAudioLanguage: string;
  youtubeRecordingDate: string;
  youtubeRecordingLatitude: string;
  youtubeRecordingLongitude: string;
  youtubeMadeForKids: boolean;
  youtubeContainsSyntheticMedia: boolean;
  tiktokPostMode: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  tiktokPhotoTitle: string;
  tiktokPhotoDescription: string;
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
  facebookPlaceId: '',
  facebookPhotoAltText: '',
  facebookVideoTitle: '',
  instagramPlacement: 'FEED',
  instagramShareToFeed: false,
  instagramLocationId: '',
  instagramAltText: '',
  instagramCollaborators: '',
  instagramUserTagsJson: '',
  pinterestBoardId: '',
  pinterestBoardSectionId: '',
  pinterestAltText: '',
  pinterestDominantColor: '',
  pinterestAiDisclosure: 'NONE',
  pinterestIsStandard: true,
  pinterestAdAccountId: '',
  pinterestProductTagsJson: '',
  thumbnailMode: 'AUTO',
  thumbnailMediaAssetId: '',
  youtubePrivacyStatus: 'public',
  youtubeCategoryId: '22',
  youtubeTags: '',
  youtubeNotifySubscribers: true,
  youtubeLicense: 'youtube',
  youtubeEmbeddable: true,
  youtubePublicStatsViewable: true,
  youtubeDefaultLanguage: '',
  youtubeDefaultAudioLanguage: '',
  youtubeRecordingDate: '',
  youtubeRecordingLatitude: '',
  youtubeRecordingLongitude: '',
  youtubeMadeForKids: false,
  youtubeContainsSyntheticMedia: false,
  tiktokPostMode: 'MEDIA_UPLOAD',
  tiktokPhotoTitle: '',
  tiktokPhotoDescription: '',
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

export interface CommonComposerContent {
  title?: string;
  body?: string;
  linkUrl?: string;
  mediaAssetIds?: string[];
}

export function platformOverrideDefaults(_platform: Platform, _scopes: string[] = []) {
  return {
    ...EMPTY_PLATFORM_OVERRIDE,
  } satisfies PlatformOverrideDraft;
}

export function platformOverrideFromCommon(
  platform: Platform,
  scopes: string[] = [],
  common: CommonComposerContent,
): PlatformOverrideDraft {
  const title = common.title?.trim() ?? '';
  const body = common.body?.trim() ?? '';
  const linkUrl = common.linkUrl?.trim() ?? '';

  const draft = platformOverrideDefaults(platform, scopes);
  draft.customized = true;
  draft.mediaAssetIds = common.mediaAssetIds ?? [];

  switch (platform) {
    case 'FACEBOOK':
      draft.caption = body;
      draft.linkUrl = linkUrl;
      break;
    case 'INSTAGRAM':
    case 'TIKTOK':
      draft.caption = body;
      break;
    case 'PINTEREST':
      draft.title = title;
      draft.description = body;
      draft.linkUrl = linkUrl;
      break;
    case 'YOUTUBE':
      draft.title = title;
      draft.description = body;
      break;
    default:
      draft.caption = body;
      draft.linkUrl = linkUrl;
      break;
  }

  return draft;
}

export function fillMissingPlatformOverrideFromCommon(
  platform: Platform,
  scopes: string[] = [],
  draft: PlatformOverrideDraft,
  common: CommonComposerContent,
): PlatformOverrideDraft {
  if (!draft.customized) return draft;

  const seeded = platformOverrideFromCommon(platform, scopes, common);

  return {
    ...draft,
    customized: true,
    title: draft.title.trim() ? draft.title : seeded.title,
    caption: draft.caption.trim() ? draft.caption : seeded.caption,
    description: draft.description.trim() ? draft.description : seeded.description,
    linkUrl: draft.linkUrl.trim() ? draft.linkUrl : seeded.linkUrl,
    mediaAssetIds: draft.mediaAssetIds.length > 0 ? draft.mediaAssetIds : seeded.mediaAssetIds,
  };
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
    facebookPlaceId: readString(options.placeId),
    facebookPhotoAltText: readString(options.photoAltText),
    facebookVideoTitle: readString(options.videoTitle),
    instagramPlacement: readEnum(options.mediaType, ['FEED', 'CAROUSEL', 'REELS', 'STORY'], 'FEED'),
    instagramShareToFeed: readBoolean(options.shareToFeed, false),
    instagramLocationId: readString(options.locationId),
    instagramAltText: readString(options.altText),
    instagramCollaborators: readCsv(options.collaborators),
    instagramUserTagsJson: readJsonText(options.userTags),
    pinterestBoardId: readString(options.boardId),
    pinterestBoardSectionId: readString(options.boardSectionId),
    pinterestAltText: readString(options.altText),
    pinterestDominantColor: readString(options.dominantColor),
    pinterestAiDisclosure:
      Array.isArray(options.aiDisclosures) && options.aiDisclosures.length > 0
        ? 'GENERATIVE_AI'
        : 'NONE',
    pinterestIsStandard: readBoolean(options.isStandard, true),
    pinterestAdAccountId: readString(options.adAccountId),
    pinterestProductTagsJson: readJsonText(options.productTags),
    thumbnailMode: readEnum(
      options.thumbnailMode,
      ['AUTO', 'GENERATED', 'MEDIA_ASSET', 'VIDEO_FRAME'],
      'AUTO',
    ),
    thumbnailMediaAssetId: readString(options.thumbnailMediaAssetId),
    youtubePrivacyStatus: readEnum(
      options.privacyStatus,
      ['public', 'unlisted', 'private'],
      'public',
    ),
    youtubeCategoryId: readString(options.categoryId) || '22',
    youtubeTags: readCsv(options.tags),
    youtubeNotifySubscribers: readBoolean(options.notifySubscribers, true),
    youtubeLicense: readEnum(options.license, ['youtube', 'creativeCommon'], 'youtube'),
    youtubeEmbeddable: readBoolean(options.embeddable, true),
    youtubePublicStatsViewable: readBoolean(options.publicStatsViewable, true),
    youtubeDefaultLanguage: readString(options.defaultLanguage),
    youtubeDefaultAudioLanguage: readString(options.defaultAudioLanguage),
    youtubeRecordingDate: readString(options.recordingDate),
    youtubeRecordingLatitude: readString(options.recordingLatitude),
    youtubeRecordingLongitude: readString(options.recordingLongitude),
    youtubeMadeForKids: readBoolean(options.selfDeclaredMadeForKids, false),
    youtubeContainsSyntheticMedia: readBoolean(options.containsSyntheticMedia, false),
    tiktokPostMode: readEnum(options.postMode, ['DIRECT_POST', 'MEDIA_UPLOAD'], 'MEDIA_UPLOAD'),
    tiktokPhotoTitle: readString(options.photoTitle),
    tiktokPhotoDescription: readString(options.photoDescription),
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
  const thumbnail = thumbnailOptions(draft);
  if (!draft.customized) return thumbnail;

  switch (platform) {
    case 'FACEBOOK':
      return compactOptions({
        postType: draft.facebookPostType === 'AUTO' ? undefined : draft.facebookPostType,
        placeId: draft.facebookPlaceId.trim() || undefined,
        photoAltText: draft.facebookPhotoAltText.trim() || undefined,
        videoTitle: draft.facebookVideoTitle.trim() || undefined,
        ...thumbnail,
      });
    case 'INSTAGRAM':
      return compactOptions({
        mediaType: draft.instagramPlacement,
        shareToFeed: draft.instagramPlacement === 'REELS' ? draft.instagramShareToFeed : undefined,
        locationId:
          draft.instagramPlacement === 'FEED' || draft.instagramPlacement === 'CAROUSEL'
            ? draft.instagramLocationId.trim() || undefined
            : undefined,
        altText:
          draft.instagramPlacement !== 'REELS' && draft.instagramPlacement !== 'STORY'
            ? draft.instagramAltText.trim() || undefined
            : undefined,
        collaborators: splitCsv(draft.instagramCollaborators),
        userTags: parseJsonArray(draft.instagramUserTagsJson),
        ...thumbnail,
      });
    case 'PINTEREST':
      return compactOptions({
        boardId: draft.pinterestBoardId.trim() || undefined,
        boardSectionId: draft.pinterestBoardSectionId.trim() || undefined,
        altText: draft.pinterestAltText.trim() || undefined,
        dominantColor: draft.pinterestDominantColor.trim() || undefined,
        aiDisclosures:
          draft.pinterestAiDisclosure === 'GENERATIVE_AI' ? ['GENERATIVE_AI'] : undefined,
        isStandard: draft.pinterestIsStandard,
        adAccountId: draft.pinterestAdAccountId.trim() || undefined,
        productTags: parseJsonArray(draft.pinterestProductTagsJson),
        ...thumbnail,
      });
    case 'YOUTUBE':
      return compactOptions({
        privacyStatus: draft.youtubePrivacyStatus,
        categoryId: draft.youtubeCategoryId.trim() || '22',
        tags: splitCsv(draft.youtubeTags),
        notifySubscribers: draft.youtubeNotifySubscribers,
        license: draft.youtubeLicense,
        embeddable: draft.youtubeEmbeddable,
        publicStatsViewable: draft.youtubePublicStatsViewable,
        defaultLanguage: draft.youtubeDefaultLanguage.trim() || undefined,
        defaultAudioLanguage: draft.youtubeDefaultAudioLanguage.trim() || undefined,
        recordingDate: draft.youtubeRecordingDate.trim() || undefined,
        recordingLatitude: draft.youtubeRecordingLatitude.trim() || undefined,
        recordingLongitude: draft.youtubeRecordingLongitude.trim() || undefined,
        selfDeclaredMadeForKids: draft.youtubeMadeForKids,
        containsSyntheticMedia: draft.youtubeContainsSyntheticMedia,
        ...thumbnail,
      });
    case 'TIKTOK': {
      const directPost = draft.tiktokPostMode === 'DIRECT_POST';
      return compactOptions({
        postMode: draft.tiktokPostMode,
        photoTitle: draft.tiktokPhotoTitle.trim() || undefined,
        photoDescription: draft.tiktokPhotoDescription.trim() || undefined,
        privacyLevel: directPost ? draft.tiktokPrivacyLevel : undefined,
        disableComment: directPost ? draft.tiktokDisableComment : undefined,
        disableDuet: directPost ? draft.tiktokDisableDuet : undefined,
        disableStitch: directPost ? draft.tiktokDisableStitch : undefined,
        videoCoverTimestampMs:
          directPost && draft.tiktokCoverTimestampMs
            ? Number(draft.tiktokCoverTimestampMs)
            : undefined,
        autoAddMusic: directPost ? draft.tiktokAutoAddMusic : undefined,
        photoCoverIndex:
          directPost && draft.tiktokPhotoCoverIndex
            ? Number(draft.tiktokPhotoCoverIndex)
            : undefined,
        consentConfirmed: directPost ? draft.tiktokConsentConfirmed : undefined,
        commercialContentEnabled: directPost ? draft.tiktokCommercialContent : undefined,
        brandContentToggle:
          directPost && draft.tiktokCommercialContent ? draft.tiktokBrandContent : undefined,
        brandOrganicToggle:
          directPost && draft.tiktokCommercialContent ? draft.tiktokBrandOrganic : undefined,
        isAiGenerated: directPost ? draft.tiktokIsAiGenerated : undefined,
      });
    }
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
  const hasOptions = hasPlatformSpecificOptions(platform, draft);
  if (!draft.customized) return hasOptions;
  return Boolean(
    draft.title.trim() ||
    draft.caption.trim() ||
    draft.description.trim() ||
    draft.linkUrl.trim() ||
    draft.mediaAssetIds.length > 0 ||
    hasOptions,
  );
}

function thumbnailOptions(draft: PlatformOverrideDraft): Record<string, unknown> | undefined {
  return compactOptions({
    thumbnailMode: draft.thumbnailMode === 'AUTO' ? undefined : draft.thumbnailMode,
    thumbnailMediaAssetId:
      draft.thumbnailMode === 'MEDIA_ASSET' || draft.thumbnailMode === 'VIDEO_FRAME'
        ? draft.thumbnailMediaAssetId.trim() || undefined
        : undefined,
  });
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

function readCsv(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join(', ')
    : readString(value);
}

function readJsonText(value: unknown): string {
  return Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value, null, 2)
    : '';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readEnum<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function splitCsv(value: string): string[] | undefined {
  const items = value
    .split(',')
    .map((item) => item.trim().replace(/^#/, ''))
    .filter(Boolean);
  return items.length ? items : undefined;
}

function parseJsonArray(value: string): unknown[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
