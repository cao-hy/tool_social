'use client';

import { useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ClipboardPaste,
  ExternalLink,
  Eye,
  Info,
  Link2,
  MessageSquareOff,
  Send,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/form-controls';
import {
  FallbackImage,
  mediaPreviewSources,
  mediaThumbnailSources,
} from '@/components/media-preview';
import { StoreSettingsModal } from '@/components/store-settings-modal';
import { useToast } from '@/components/toast-provider';
import { commentsApi, storesApi } from '@/lib/api-client';
import { workspaceQueryKeys } from '@/lib/workspace-queries';
import {
  AUTO_UTM_STORAGE_KEY,
  attachUtmToUrlsInText,
  isTemplateMatchingStoreSlug,
  platformShortLabel,
  platformUtmSource,
  sortTemplatesForStoreSlugs,
  toVariableTemplateBody,
} from '@/lib/comment-templates';
import { getErrorMessage } from '@/lib/errors';
import type {
  ContentPostView,
  MediaAssetView,
  PlatformCapabilitiesView,
  PlatformPostView,
  ReplyTemplateView,
  StoreView,
} from '@/lib/types';

type DateWindowKey = '3D' | '7D' | '14D' | 'ALL';
type ModalMediaFilter = 'ALL' | 'VIDEO' | 'IMAGE' | 'NONE';
type ModalPlatformFilter = 'ALL' | Platform;
type ModalStoreFilter = 'ALL' | 'UNASSIGNED' | string;
type BulkLinkToolMode = 'NONE' | 'SHARED' | 'LINES';

interface StoreOptionItem {
  id: string;
  name: string;
  slug: string | null;
  color: string | null;
}

const DATE_WINDOW_DAYS: Record<Exclude<DateWindowKey, 'ALL'>, number> = {
  '3D': 3,
  '7D': 7,
  '14D': 14,
};

export function isCreateCommentSupportedPlatform(
  platform: Platform,
  capabilityByPlatform?: Partial<Record<Platform, PlatformCapabilitiesView>>,
): boolean {
  const cap = capabilityByPlatform?.[platform]?.capabilities?.createComment;
  if (cap) {
    return cap.state === 'SUPPORTED' || cap.state === 'CONDITIONAL';
  }
  return platform === 'FACEBOOK' || platform === 'INSTAGRAM' || platform === 'YOUTUBE';
}

function getEffectivePostMedia(post: ContentPostView): MediaAssetView[] {
  if (post.media.length > 0) return post.media;
  return post.platformPosts.find((pp) => pp.media.length > 0)?.media ?? [];
}

function matchesModalMediaFilter(post: ContentPostView, filter: ModalMediaFilter): boolean {
  if (filter === 'ALL') return true;
  const media = getEffectivePostMedia(post);
  if (filter === 'NONE') return media.length === 0;
  return media.some((item) => item.type === filter);
}

function resolveTargetStoreMeta(post: ContentPostView, target: PlatformPostView): StoreOptionItem {
  const store = target.store ?? post.store ?? null;
  const storeId = target.storeId ?? store?.id ?? post.storeId ?? null;
  if (!storeId) {
    return {
      id: 'UNASSIGNED',
      name: 'Chưa gán Store',
      slug: null,
      color: null,
    };
  }
  return {
    id: storeId,
    name: store?.name ?? storeId,
    slug: store?.slug ?? null,
    color: store?.color ?? null,
  };
}

function isStoreShortLink(urlStr: string, store?: StoreView | null): boolean {
  const trimmed = urlStr.trim();
  if (!trimmed || !store?.shopify?.publicDomain) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const pub = store.shopify.publicDomain.replace(/^www\./i, '').toLowerCase();
    const prefix = store.shopify.shortPathPrefix || '/s/';
    return (
      host === pub && parsed.pathname.startsWith(prefix) && parsed.pathname.length > prefix.length
    );
  } catch {
    return false;
  }
}

function targetMatchesStoreFilter(
  post: ContentPostView,
  target: PlatformPostView,
  storeFilter: ModalStoreFilter,
): boolean {
  if (storeFilter === 'ALL') return true;
  return resolveTargetStoreMeta(post, target).id === storeFilter;
}

function getPostEffectiveTimestampMs(post: ContentPostView): number {
  const candidates = [
    post.publishedAt,
    ...post.platformPosts.map((pp) => pp.publishedAt),
    post.createdAt,
  ].filter((v): v is string => Boolean(v));
  for (const iso of candidates) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

function formatPostShortTime(post: ContentPostView): string {
  const ms = getPostEffectiveTimestampMs(post);
  if (!ms) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ms));
}

function resolveReadablePostLabel(post: ContentPostView, targets: PlatformPostView[]): string {
  const rawText =
    post.title?.trim() ||
    post.body?.trim() ||
    targets.find((t) => t.title?.trim())?.title?.trim() ||
    targets.find((t) => t.caption?.trim())?.caption?.trim() ||
    targets.find((t) => t.description?.trim())?.description?.trim() ||
    '';

  if (rawText) {
    const firstLine =
      rawText
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim() ?? rawText;
    return firstLine.length > 85 ? `${firstLine.slice(0, 85)}…` : firstLine;
  }

  const effectiveMedia = getEffectivePostMedia(post);
  const mediaLabel =
    effectiveMedia[0]?.type === 'VIDEO' ? 'Video' : effectiveMedia.length > 0 ? 'Ảnh' : 'Bài đăng';
  const timeStr = formatPostShortTime(post);
  return timeStr ? `${mediaLabel} đăng lúc ${timeStr}` : `${mediaLabel} (không có caption)`;
}

interface BulkPostCommentModalProps {
  workspaceId: string;
  posts: ContentPostView[];
  stores?: StoreView[];
  capabilityByPlatform?: Partial<Record<Platform, PlatformCapabilitiesView>>;
  isExplicitSelection?: boolean;
  initialStoreId?: string;
  lockedStoreId?: string;
  initialPlatform?: string;
  initialMediaType?: '' | 'VIDEO' | 'IMAGE' | 'NONE';
  onClose: () => void;
  onSubmitted?: () => void;
}

export function BulkPostCommentModal({
  workspaceId,
  posts,
  stores = [],
  capabilityByPlatform,
  isExplicitSelection = false,
  initialStoreId,
  lockedStoreId,
  initialPlatform,
  initialMediaType,
  onClose,
  onSubmitted,
}: BulkPostCommentModalProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [localStores, setLocalStores] = useState<StoreView[]>(stores);
  const [shopifySetupStore, setShopifySetupStore] = useState<StoreView | null>(null);
  const [shorteningAll, setShorteningAll] = useState(false);
  const [shorteningShared, setShorteningShared] = useState(false);
  const [shorteningPostId, setShorteningPostId] = useState<string | null>(null);
  const [autoShortenBulkLines, setAutoShortenBulkLines] = useState(true);

  useEffect(() => {
    setLocalStores(stores);
  }, [stores]);

  // Ensure fresh StoreView list (with shopify & proxy summary) when modal opens
  useEffect(() => {
    if (posts.length === 0) return;
    let cancelled = false;
    void storesApi
      .list(workspaceId)
      .then((res) => {
        if (cancelled) return;
        setLocalStores(res.items);
        queryClient.setQueryData(workspaceQueryKeys.stores(workspaceId), res);
      })
      .catch(() => {
        // non-critical
      });
    return () => {
      cancelled = true;
    };
  }, [posts.length, queryClient, workspaceId]);

  const [templates, setTemplates] = useState<ReplyTemplateView[]>([]);
  const [templateText, setTemplateText] = useState('');
  const [isCustomTypedTemplate, setIsCustomTypedTemplate] = useState(false);
  const [showAllStoreTemplates, setShowAllStoreTemplates] = useState(false);

  // Tier 1: Scope filters
  const [storeFilter, setStoreFilter] = useState<ModalStoreFilter>('ALL');
  const [platformFilter, setPlatformFilter] = useState<ModalPlatformFilter>('ALL');
  const [mediaFilter, setMediaFilter] = useState<ModalMediaFilter>('ALL');
  const [dateWindow, setDateWindow] = useState<DateWindowKey>('ALL');

  // Tier 2: Action & Safety toggles
  const [hideCommented, setHideCommented] = useState(false);
  const [onlyMissingLinks, setOnlyMissingLinks] = useState(false);
  const [pinnedMissingPostIds, setPinnedMissingPostIds] = useState<string[]>([]);

  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [linkByPostId, setLinkByPostId] = useState<Record<string, string>>({});
  const [bulkLinkToolMode, setBulkLinkToolMode] = useState<BulkLinkToolMode>('NONE');
  const [sharedLinkInput, setSharedLinkInput] = useState('');
  const [bulkLinksRaw, setBulkLinksRaw] = useState('');
  const [autoAttachUtm, setAutoAttachUtm] = useState(true);
  const [previewPostId, setPreviewPostId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const templateTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isPostWithinWindow = useCallback((post: ContentPostView, win: DateWindowKey): boolean => {
    if (win === 'ALL') return true;
    const ms = getPostEffectiveTimestampMs(post);
    if (!ms) return true;
    const cutoff = Date.now() - DATE_WINDOW_DAYS[win] * 24 * 60 * 60 * 1000;
    return ms >= cutoff;
  }, []);

  // Split published platformPosts into API-supported vs API-unsupported
  const allCandidateEntries = useMemo(
    () =>
      posts.map((post) => {
        const published = post.platformPosts.filter(
          (pp) => pp.status === 'PUBLISHED' && Boolean(pp.externalPostId),
        );
        const supportedTargets = published.filter((pp) =>
          isCreateCommentSupportedPlatform(pp.platform, capabilityByPlatform),
        );
        const unsupportedTargets = published.filter(
          (pp) => !isCreateCommentSupportedPlatform(pp.platform, capabilityByPlatform),
        );
        return { post, supportedTargets, unsupportedTargets };
      }),
    [capabilityByPlatform, posts],
  );

  // All-time target counts per store (used to distinguish active stores vs 0-post stores)
  const allTimeStoreCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { post, supportedTargets } of allCandidateEntries) {
      for (const target of supportedTargets) {
        const meta = resolveTargetStoreMeta(post, target);
        counts.set(meta.id, (counts.get(meta.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [allCandidateEntries]);

  // Full store catalog combining workspace stores + any store present on candidate posts
  const storeCatalog = useMemo(() => {
    const byId = new Map<string, StoreOptionItem>();
    for (const wsStore of localStores) {
      byId.set(wsStore.id, {
        id: wsStore.id,
        name: wsStore.name,
        slug: wsStore.slug,
        color: wsStore.color,
      });
    }
    for (const { post, supportedTargets } of allCandidateEntries) {
      for (const target of supportedTargets) {
        const meta = resolveTargetStoreMeta(post, target);
        if (!byId.has(meta.id)) {
          byId.set(meta.id, meta);
        }
      }
    }
    // Put stores with commentable posts first, then 0-post stores, UNASSIGNED last
    return Array.from(byId.values()).sort((a, b) => {
      const aHasPosts = (allTimeStoreCounts.get(a.id) ?? 0) > 0;
      const bHasPosts = (allTimeStoreCounts.get(b.id) ?? 0) > 0;
      if (aHasPosts !== bHasPosts) return aHasPosts ? -1 : 1;
      if (a.id === 'UNASSIGNED') return 1;
      if (b.id === 'UNASSIGNED') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [allCandidateEntries, allTimeStoreCounts, localStores]);

  const storeById = useMemo(
    () => new Map(localStores.map((item) => [item.id, item])),
    [localStores],
  );

  const storesWithPosts = useMemo(
    () => storeCatalog.filter((item) => (allTimeStoreCounts.get(item.id) ?? 0) > 0),
    [allTimeStoreCounts, storeCatalog],
  );

  // Faceted counts for Store select (respecting dateWindow so counts match time horizon)
  const storeOptionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const { post, supportedTargets } of allCandidateEntries) {
      if (!isPostWithinWindow(post, dateWindow)) continue;
      for (const target of supportedTargets) {
        const meta = resolveTargetStoreMeta(post, target);
        counts.set(meta.id, (counts.get(meta.id) ?? 0) + 1);
        total += 1;
      }
    }
    return { byStoreId: counts, total };
  }, [allCandidateEntries, dateWindow, isPostWithinWindow]);

  // Faceted counts for Date Window select (respecting store + platform + media)
  const windowTargetCounts = useMemo(() => {
    const counts: Record<DateWindowKey, number> = { '3D': 0, '7D': 0, '14D': 0, ALL: 0 };
    for (const { post, supportedTargets } of allCandidateEntries) {
      if (!matchesModalMediaFilter(post, mediaFilter)) continue;
      const scopedTargets = supportedTargets.filter(
        (t) =>
          targetMatchesStoreFilter(post, t, storeFilter) &&
          (platformFilter === 'ALL' || t.platform === platformFilter),
      );
      const len = scopedTargets.length;
      if (len === 0) continue;
      counts.ALL += len;
      if (isPostWithinWindow(post, '14D')) counts['14D'] += len;
      if (isPostWithinWindow(post, '7D')) counts['7D'] += len;
      if (isPostWithinWindow(post, '3D')) counts['3D'] += len;
    }
    return counts;
  }, [allCandidateEntries, isPostWithinWindow, mediaFilter, platformFilter, storeFilter]);

  // Faceted counts for Social Platform select (respecting store + dateWindow + media)
  const platformFacet = useMemo(() => {
    const supportedByPlatform = new Map<Platform, number>();
    const unsupportedByPlatform = new Map<Platform, number>();
    let totalSupported = 0;

    for (const { post, supportedTargets, unsupportedTargets } of allCandidateEntries) {
      if (!isPostWithinWindow(post, dateWindow)) continue;
      if (!matchesModalMediaFilter(post, mediaFilter)) continue;

      for (const t of supportedTargets) {
        if (!targetMatchesStoreFilter(post, t, storeFilter)) continue;
        supportedByPlatform.set(t.platform, (supportedByPlatform.get(t.platform) ?? 0) + 1);
        totalSupported += 1;
      }
      for (const u of unsupportedTargets) {
        if (!targetMatchesStoreFilter(post, u, storeFilter)) continue;
        unsupportedByPlatform.set(u.platform, (unsupportedByPlatform.get(u.platform) ?? 0) + 1);
      }
    }

    return {
      supported: Array.from(supportedByPlatform.entries()),
      unsupported: Array.from(unsupportedByPlatform.entries()),
      totalSupported,
    };
  }, [allCandidateEntries, dateWindow, isPostWithinWindow, mediaFilter, storeFilter]);

  // Faceted counts for Media select (respecting store + dateWindow + platform)
  const mediaPostCounts = useMemo(() => {
    const counts = { ALL: 0, VIDEO: 0, IMAGE: 0, NONE: 0 };
    for (const { post, supportedTargets } of allCandidateEntries) {
      if (!isPostWithinWindow(post, dateWindow)) continue;
      const matchingTargets = supportedTargets.filter(
        (t) =>
          targetMatchesStoreFilter(post, t, storeFilter) &&
          (platformFilter === 'ALL' || t.platform === platformFilter),
      );
      if (matchingTargets.length === 0) continue;
      counts.ALL += 1;
      if (matchesModalMediaFilter(post, 'VIDEO')) counts.VIDEO += 1;
      if (matchesModalMediaFilter(post, 'IMAGE')) counts.IMAGE += 1;
      if (matchesModalMediaFilter(post, 'NONE')) counts.NONE += 1;
    }
    return counts;
  }, [allCandidateEntries, dateWindow, isPostWithinWindow, platformFilter, storeFilter]);

  // Entries after Tier 1 Scope Filters (before hideCommented)
  const scopeFilteredPosts = useMemo(
    () =>
      allCandidateEntries
        .filter(
          ({ post }) =>
            isPostWithinWindow(post, dateWindow) && matchesModalMediaFilter(post, mediaFilter),
        )
        .map(({ post, supportedTargets }) => ({
          post,
          targets: supportedTargets.filter(
            (t) =>
              targetMatchesStoreFilter(post, t, storeFilter) &&
              (platformFilter === 'ALL' || t.platform === platformFilter),
          ),
        }))
        .filter((entry) => entry.targets.length > 0),
    [allCandidateEntries, dateWindow, isPostWithinWindow, mediaFilter, platformFilter, storeFilter],
  );

  const scopeAllTargets = useMemo(
    () => scopeFilteredPosts.flatMap((entry) => entry.targets),
    [scopeFilteredPosts],
  );

  const commentedTargetsCount = useMemo(
    () => scopeAllTargets.filter((t) => (t.commentCount ?? 0) > 0).length,
    [scopeAllTargets],
  );

  // Working post list after applying hideCommented
  const postsWithTargets = useMemo(
    () =>
      scopeFilteredPosts
        .map(({ post, targets }) => ({
          post,
          targets: hideCommented ? targets.filter((t) => (t.commentCount ?? 0) === 0) : targets,
        }))
        .filter((entry) => entry.targets.length > 0),
    [hideCommented, scopeFilteredPosts],
  );

  const allTargets = useMemo(
    () => postsWithTargets.flatMap((entry) => entry.targets),
    [postsWithTargets],
  );

  const activeStoreSlugs = useMemo(() => {
    const slugs = new Set<string>();
    if (storeFilter !== 'ALL' && storeFilter !== 'UNASSIGNED') {
      const selectedStore = storeCatalog.find((s) => s.id === storeFilter);
      if (selectedStore?.slug) slugs.add(selectedStore.slug.toLowerCase());
    }
    for (const { post, targets } of scopeFilteredPosts) {
      if (post.store?.slug) slugs.add(post.store.slug.toLowerCase());
      for (const t of targets) {
        if (t.store?.slug) slugs.add(t.store.slug.toLowerCase());
      }
    }
    return Array.from(slugs);
  }, [scopeFilteredPosts, storeCatalog, storeFilter]);

  const sortedTemplates = useMemo(
    () => sortTemplatesForStoreSlugs(templates, activeStoreSlugs),
    [activeStoreSlugs, templates],
  );

  const { primaryTemplates, extraTemplates } = useMemo(() => {
    if (activeStoreSlugs.length === 0) {
      return { primaryTemplates: sortedTemplates, extraTemplates: [] as ReplyTemplateView[] };
    }
    const matched = sortedTemplates.filter((tpl) =>
      activeStoreSlugs.some((slug) => isTemplateMatchingStoreSlug(tpl.name, slug)),
    );
    if (matched.length === 0) {
      return { primaryTemplates: sortedTemplates, extraTemplates: [] as ReplyTemplateView[] };
    }
    const matchedIds = new Set(matched.map((tpl) => tpl.id));
    const others = sortedTemplates.filter((tpl) => !matchedIds.has(tpl.id));
    return { primaryTemplates: matched, extraTemplates: others };
  }, [activeStoreSlugs, sortedTemplates]);

  const pickPreferredTemplateForSlugs = useCallback(
    (slugs: string[], availableTemplates: ReplyTemplateView[]): ReplyTemplateView | undefined => {
      if (availableTemplates.length === 0) return undefined;
      const ordered = sortTemplatesForStoreSlugs(availableTemplates, slugs);
      return (
        ordered.find(
          (tpl) =>
            slugs.some((slug) => isTemplateMatchingStoreSlug(tpl.name, slug)) &&
            tpl.name.toLowerCase().includes('ghim'),
        ) ??
        ordered.find((tpl) => slugs.some((slug) => isTemplateMatchingStoreSlug(tpl.name, slug))) ??
        ordered[0]
      );
    },
    [],
  );

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(AUTO_UTM_STORAGE_KEY);
      if (saved !== null) {
        setAutoAttachUtm(saved === '1');
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const computeTargetsForFilters = useCallback(
    (
      nextStore: ModalStoreFilter,
      nextPlatform: ModalPlatformFilter,
      nextMedia: ModalMediaFilter,
      nextWindow: DateWindowKey,
      nextHideCommented: boolean,
    ): string[] => {
      return allCandidateEntries
        .filter(
          ({ post }) =>
            isPostWithinWindow(post, nextWindow) && matchesModalMediaFilter(post, nextMedia),
        )
        .flatMap(({ post, supportedTargets }) =>
          supportedTargets
            .filter(
              (t) =>
                targetMatchesStoreFilter(post, t, nextStore) &&
                (nextPlatform === 'ALL' || t.platform === nextPlatform) &&
                (nextHideCommented ? (t.commentCount ?? 0) === 0 : true),
            )
            .map((t) => t.id),
        );
    },
    [allCandidateEntries, isPostWithinWindow],
  );

  // Reset state whenever modal opens with a new selection of posts
  useEffect(() => {
    if (posts.length === 0) return;

    const requestedStore =
      lockedStoreId ??
      (initialStoreId && storesWithPosts.some((item) => item.id === initialStoreId)
        ? initialStoreId
        : null);

    // Brand-Safe Default: honor lockedStoreId or outer Store filter; otherwise default to the first store with posts.
    const defaultStore: ModalStoreFilter =
      requestedStore ??
      (storesWithPosts.length === 1
        ? (storesWithPosts[0]?.id ?? 'ALL')
        : !isExplicitSelection && storesWithPosts.length > 1
          ? (storesWithPosts[0]?.id ?? 'ALL')
          : 'ALL');

    const defaultPlatform: ModalPlatformFilter =
      !isExplicitSelection &&
      initialPlatform &&
      isCreateCommentSupportedPlatform(initialPlatform as Platform, capabilityByPlatform)
        ? (initialPlatform as Platform)
        : 'ALL';

    const defaultMedia: ModalMediaFilter =
      !isExplicitSelection && initialMediaType ? initialMediaType : 'ALL';

    const scopedTotal = allCandidateEntries.reduce((sum, { post, supportedTargets }) => {
      if (!matchesModalMediaFilter(post, defaultMedia)) return sum;
      return (
        sum +
        supportedTargets.filter(
          (t) =>
            targetMatchesStoreFilter(post, t, defaultStore) &&
            (defaultPlatform === 'ALL' || t.platform === defaultPlatform),
        ).length
      );
    }, 0);
    const scopedSevenDay = allCandidateEntries.reduce((sum, { post, supportedTargets }) => {
      if (!isPostWithinWindow(post, '7D') || !matchesModalMediaFilter(post, defaultMedia)) {
        return sum;
      }
      return (
        sum +
        supportedTargets.filter(
          (t) =>
            targetMatchesStoreFilter(post, t, defaultStore) &&
            (defaultPlatform === 'ALL' || t.platform === defaultPlatform),
        ).length
      );
    }, 0);

    const initialWindow: DateWindowKey =
      !isExplicitSelection && scopedSevenDay > 0 && scopedTotal > scopedSevenDay ? '7D' : 'ALL';

    setStoreFilter(defaultStore);
    setPlatformFilter(defaultPlatform);
    setMediaFilter(defaultMedia);
    setDateWindow(initialWindow);
    setHideCommented(false);
    setOnlyMissingLinks(false);
    setPinnedMissingPostIds([]);
    setShowAllStoreTemplates(false);
    setPreviewPostId(null);

    setSelectedTargetIds(
      computeTargetsForFilters(defaultStore, defaultPlatform, defaultMedia, initialWindow, false),
    );

    const initLinks: Record<string, string> = {};
    for (const post of posts) {
      const defaultLink =
        post.linkUrl?.trim() ||
        post.platformPosts.find((pp) => pp.linkUrl?.trim())?.linkUrl?.trim() ||
        '';
      initLinks[post.id] = defaultLink;
    }
    setLinkByPostId(initLinks);
    setSharedLinkInput('');
    setBulkLinkToolMode('NONE');
    setBulkLinksRaw('');
    setIsCustomTypedTemplate(false);
    setTemplateText('');
  }, [
    allCandidateEntries,
    capabilityByPlatform,
    computeTargetsForFilters,
    initialMediaType,
    initialPlatform,
    initialStoreId,
    lockedStoreId,
    isExplicitSelection,
    isPostWithinWindow,
    posts,
    storesWithPosts,
  ]);

  const effectiveTemplateStoreId =
    lockedStoreId ??
    (storeFilter !== 'ALL' && storeFilter !== 'UNASSIGNED' ? storeFilter : undefined);

  // Load saved ReplyTemplates (scoped to active store + shared templates)
  useEffect(() => {
    if (posts.length === 0) return;
    let cancelled = false;
    void commentsApi
      .listTemplates(workspaceId, effectiveTemplateStoreId)
      .then((res) => {
        if (cancelled) return;
        setTemplates(res.items);
      })
      .catch(() => {
        // non-critical
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveTemplateStoreId, posts.length, workspaceId]);

  // Auto-pick preferred store pin-link template on open (or when switching Store before custom typing)
  useEffect(() => {
    if (posts.length === 0 || isCustomTypedTemplate) return;
    if (templates.length === 0) return;
    const preferred = pickPreferredTemplateForSlugs(activeStoreSlugs, templates);
    if (preferred) {
      setTemplateText(toVariableTemplateBody(preferred.body));
    }
  }, [
    activeStoreSlugs,
    isCustomTypedTemplate,
    pickPreferredTemplateForSlugs,
    posts.length,
    templates,
  ]);

  const renderMessageForTarget = useCallback(
    (post: ContentPostView, target: PlatformPostView): string => {
      const postLink = (linkByPostId[post.id] ?? '').trim();
      const postTitle = (post.title || target.title || '').trim();
      let rendered = templateText.trim();
      if (rendered.includes('{link}')) {
        rendered = rendered.replaceAll('{link}', postLink || '{chưa_điền_link}');
      }
      if (rendered.includes('{title}')) {
        rendered = rendered.replaceAll('{title}', postTitle);
      }
      if (autoAttachUtm && postLink) {
        rendered = attachUtmToUrlsInText(rendered, target.platform);
      }
      return rendered.trim();
    },
    [autoAttachUtm, linkByPostId, templateText],
  );

  const previewSample = useMemo(() => {
    if (previewPostId) {
      const explicitEntry = postsWithTargets.find(({ post }) => post.id === previewPostId);
      const explicitTarget =
        explicitEntry?.targets.find((t) => selectedTargetIds.includes(t.id)) ??
        explicitEntry?.targets[0];
      if (explicitEntry && explicitTarget) {
        return {
          post: explicitEntry.post,
          target: explicitTarget,
          rendered: templateText.trim()
            ? renderMessageForTarget(explicitEntry.post, explicitTarget)
            : '',
        };
      }
    }
    for (const { post, targets } of postsWithTargets) {
      const target = targets.find((t) => selectedTargetIds.includes(t.id));
      if (target) {
        return {
          post,
          target,
          rendered: templateText.trim() ? renderMessageForTarget(post, target) : '',
        };
      }
    }
    return null;
  }, [postsWithTargets, previewPostId, renderMessageForTarget, selectedTargetIds, templateText]);

  if (posts.length === 0) return null;

  const usesLinkVariable = templateText.includes('{link}');

  const activePostsWithSelectedTargets = postsWithTargets.filter(({ targets }) =>
    targets.some((t) => selectedTargetIds.includes(t.id)),
  );

  const missingLinkPostIds = usesLinkVariable
    ? activePostsWithSelectedTargets
        .filter(({ post }) => !(linkByPostId[post.id] ?? '').trim())
        .map(({ post }) => post.id)
    : [];

  const missingIdSet = new Set(missingLinkPostIds);
  const pinnedMissingSet = new Set(pinnedMissingPostIds);

  const displayedPosts =
    onlyMissingLinks && usesLinkVariable
      ? postsWithTargets
          .map((entry, originalIndex) => ({ ...entry, originalIndex }))
          .filter(({ post }) => missingIdSet.has(post.id) || pinnedMissingSet.has(post.id))
      : postsWithTargets.map((entry, originalIndex) => ({ ...entry, originalIndex }));

  // Detect if multiple stores are simultaneously selected (for brand-safety warning)
  const selectedDistinctStoreNames = Array.from(
    new Set(
      postsWithTargets.flatMap(({ post, targets }) =>
        targets
          .filter((t) => selectedTargetIds.includes(t.id))
          .map((t) => resolveTargetStoreMeta(post, t).name),
      ),
    ),
  );

  function applyScopeChange(
    nextStore: ModalStoreFilter,
    nextPlatform: ModalPlatformFilter,
    nextMedia: ModalMediaFilter,
    nextWindow: DateWindowKey,
    nextHideCommented: boolean,
  ) {
    setStoreFilter(nextStore);
    setPlatformFilter(nextPlatform);
    setMediaFilter(nextMedia);
    setDateWindow(nextWindow);
    setHideCommented(nextHideCommented);
    setOnlyMissingLinks(false);
    setPinnedMissingPostIds([]);
    setSelectedTargetIds(
      computeTargetsForFilters(nextStore, nextPlatform, nextMedia, nextWindow, nextHideCommented),
    );
  }

  function handleChangeStore(nextStore: ModalStoreFilter) {
    setShowAllStoreTemplates(false);
    // If the user switched to a Store whose current dateWindow has 0 targets, widen to ALL automatically
    const nextTargetsInCurrentWindow = computeTargetsForFilters(
      nextStore,
      platformFilter,
      mediaFilter,
      dateWindow,
      hideCommented,
    );
    const effectiveWindow =
      nextTargetsInCurrentWindow.length === 0 && dateWindow !== 'ALL' ? 'ALL' : dateWindow;
    applyScopeChange(nextStore, platformFilter, mediaFilter, effectiveWindow, hideCommented);
  }

  function handleToggleOnlyMissingLinks() {
    if (onlyMissingLinks) {
      setOnlyMissingLinks(false);
      setPinnedMissingPostIds([]);
      return;
    }
    setPinnedMissingPostIds(missingLinkPostIds);
    setOnlyMissingLinks(true);
  }

  function toggleAutoUtm(checked: boolean) {
    setAutoAttachUtm(checked);
    try {
      window.localStorage.setItem(AUTO_UTM_STORAGE_KEY, checked ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }

  function insertVariableAtCursor(variableToken: string) {
    const el = templateTextareaRef.current;
    if (!el) {
      setIsCustomTypedTemplate(true);
      setTemplateText((prev) => `${prev}${prev.endsWith(' ') || !prev ? '' : ' '}${variableToken}`);
      return;
    }
    const start = el.selectionStart ?? templateText.length;
    const end = el.selectionEnd ?? templateText.length;
    const next = `${templateText.slice(0, start)}${variableToken}${templateText.slice(end)}`;
    setIsCustomTypedTemplate(true);
    setTemplateText(next);
    window.setTimeout(() => {
      el.focus();
      const pos = start + variableToken.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  function resolvePostStore(post: ContentPostView, targets: PlatformPostView[]): StoreView | null {
    const primaryTarget = targets[0];
    const storeId =
      (primaryTarget ? resolveTargetStoreMeta(post, primaryTarget).id : null) ??
      post.storeId ??
      post.store?.id ??
      null;
    if (!storeId || storeId === 'UNASSIGNED') return null;
    return storeById.get(storeId) ?? null;
  }

  function resolveActiveSingleStore(): StoreView | null {
    if (storeFilter !== 'ALL' && storeFilter !== 'UNASSIGNED') {
      return storeById.get(storeFilter) ?? null;
    }
    const distinctIds = Array.from(
      new Set(
        displayedPosts
          .map(({ post, targets }) => resolvePostStore(post, targets)?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (distinctIds.length === 1 && distinctIds[0]) {
      return storeById.get(distinctIds[0]) ?? null;
    }
    return null;
  }

  async function shortenLinksMapByPost(
    sourceMap: Record<string, string>,
    targetEntries: Array<{ post: ContentPostView; targets: PlatformPostView[] }>,
  ): Promise<{
    updatedMap: Record<string, string>;
    shortenedCount: number;
    skippedNoShopify: number;
  }> {
    const groupedByStore = new Map<
      string,
      { store: StoreView; postIdsByUrl: Map<string, string[]> }
    >();
    let skippedNoShopify = 0;
    let firstUnconnectedStore: StoreView | null = null;

    for (const { post, targets } of targetEntries) {
      const rawUrl = (sourceMap[post.id] ?? '').trim();
      if (!rawUrl) continue;
      const store = resolvePostStore(post, targets);
      if (!store) {
        skippedNoShopify += 1;
        continue;
      }
      if (!store.shopify?.connected || !store.shopify.enabled) {
        skippedNoShopify += 1;
        if (!firstUnconnectedStore) firstUnconnectedStore = store;
        continue;
      }
      if (isStoreShortLink(rawUrl, store)) continue;

      let bucket = groupedByStore.get(store.id);
      if (!bucket) {
        bucket = { store, postIdsByUrl: new Map() };
        groupedByStore.set(store.id, bucket);
      }
      const list = bucket.postIdsByUrl.get(rawUrl) ?? [];
      list.push(post.id);
      bucket.postIdsByUrl.set(rawUrl, list);
    }

    if (groupedByStore.size === 0) {
      if (firstUnconnectedStore) {
        setShopifySetupStore(firstUnconnectedStore);
        toast.warning(
          `Store "${firstUnconnectedStore.name}" chưa gắn Shopify Custom App. Gắn nhanh 1 phút ngay tại đây để rút gọn link /s/!`,
        );
      }
      return { updatedMap: sourceMap, shortenedCount: 0, skippedNoShopify };
    }

    const nextMap: Record<string, string> = { ...sourceMap };
    let shortenedCount = 0;

    await Promise.all(
      Array.from(groupedByStore.values()).map(async ({ store, postIdsByUrl }) => {
        const urls = Array.from(postIdsByUrl.keys());
        const res = await storesApi.shortenLinks(workspaceId, store.id, {
          urls,
          cleanTracking: true,
        });
        for (const item of res.items) {
          if (!item.shortUrl) continue;
          const postIds = postIdsByUrl.get(item.inputUrl) ?? [];
          for (const pid of postIds) {
            nextMap[pid] = item.shortUrl;
            shortenedCount += 1;
          }
        }
      }),
    );

    return { updatedMap: nextMap, shortenedCount, skippedNoShopify };
  }

  async function handleShortenDisplayedPostLinks() {
    const filledEntries = displayedPosts.filter(({ post }) =>
      Boolean((linkByPostId[post.id] ?? '').trim()),
    );
    if (filledEntries.length === 0) {
      const singleStore = resolveActiveSingleStore();
      if (singleStore && (!singleStore.shopify?.connected || !singleStore.shopify.enabled)) {
        setShopifySetupStore(singleStore);
        toast.warning(
          `Store "${singleStore.name}" chưa gắn Shopify. Kết nối Shopify trước rồi dán link sản phẩm để rút gọn /s/!`,
        );
        return;
      }
      toast.warning('Vui lòng điền ít nhất 1 link sản phẩm trước khi bấm Rút gọn link (/s/).');
      return;
    }

    setShorteningAll(true);
    try {
      const { updatedMap, shortenedCount, skippedNoShopify } = await shortenLinksMapByPost(
        linkByPostId,
        filledEntries,
      );
      setLinkByPostId(updatedMap);
      if (shortenedCount > 0) {
        toast.success(
          skippedNoShopify > 0
            ? `Đã rút gọn ${shortenedCount} link sang /s/! (${skippedNoShopify} bài chưa gắn Shopify được giữ nguyên)`
            : `Đã rút gọn ${shortenedCount} link sạch sang /s/!`,
        );
      } else if (skippedNoShopify === 0) {
        toast.success('Tất cả các link đang điền đều đã ở dạng rút gọn /s/ sẵn.');
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setShorteningAll(false);
    }
  }

  async function handleShortenSinglePostLink(post: ContentPostView, targets: PlatformPostView[]) {
    const rawUrl = (linkByPostId[post.id] ?? '').trim();
    if (!rawUrl) return;
    const store = resolvePostStore(post, targets);
    if (!store) {
      toast.warning('Bài viết này chưa thuộc Store nào nên chưa xác định được domain /s/.');
      return;
    }
    if (!store.shopify?.connected || !store.shopify.enabled) {
      setShopifySetupStore(store);
      toast.warning(
        `Store "${store.name}" chưa gắn Shopify. Kết nối nhanh trong 1 phút để dùng link ${store.name} /s/!`,
      );
      return;
    }

    setShorteningPostId(post.id);
    try {
      const res = await storesApi.shortenLinks(workspaceId, store.id, {
        urls: [rawUrl],
        cleanTracking: true,
      });
      const first = res.items[0];
      if (first?.shortUrl) {
        const shortUrl = first.shortUrl;
        setLinkByPostId((prev) => ({ ...prev, [post.id]: shortUrl }));
        toast.success(`Đã rút gọn thành ${shortUrl}`);
      } else if (first?.error) {
        toast.error(first.error);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setShorteningPostId(null);
    }
  }

  function applySharedLinkToAll() {
    const trimmed = sharedLinkInput.trim();
    if (!trimmed) return;
    const next: Record<string, string> = { ...linkByPostId };
    for (const { post } of displayedPosts) {
      next[post.id] = trimmed;
    }
    setLinkByPostId(next);
    setBulkLinkToolMode('NONE');
    toast.success(`Đã điền link chung cho ${displayedPosts.length} bài viết.`);
  }

  async function shortenAndApplySharedLinkToAll() {
    const trimmed = sharedLinkInput.trim();
    if (!trimmed) return;
    const singleStore = resolveActiveSingleStore();
    if (singleStore && (!singleStore.shopify?.connected || !singleStore.shopify.enabled)) {
      setShopifySetupStore(singleStore);
      toast.warning(
        `Store "${singleStore.name}" chưa gắn Shopify Custom App. Gắn nhanh tại đây để rút gọn link chung sang /s/!`,
      );
      return;
    }

    setShorteningShared(true);
    try {
      const seeded: Record<string, string> = { ...linkByPostId };
      for (const { post } of displayedPosts) {
        seeded[post.id] = trimmed;
      }
      const { updatedMap, shortenedCount } = await shortenLinksMapByPost(seeded, displayedPosts);
      setLinkByPostId(updatedMap);
      if (shortenedCount > 0) {
        setBulkLinkToolMode('NONE');
        toast.success(`Đã rút gọn sang /s/ và điền cho ${displayedPosts.length} bài viết!`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setShorteningShared(false);
    }
  }

  async function applyBulkLinesToPosts() {
    const lines = bulkLinksRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      toast.warning('Vui lòng dán ít nhất 1 dòng link sản phẩm.');
      return;
    }
    const next: Record<string, string> = { ...linkByPostId };
    const affectedEntries: Array<{ post: ContentPostView; targets: PlatformPostView[] }> = [];
    let applied = 0;
    displayedPosts.forEach((entry, idx) => {
      const line = lines[idx];
      if (line) {
        next[entry.post.id] = line;
        affectedEntries.push(entry);
        applied += 1;
      }
    });

    if (autoShortenBulkLines) {
      const anyConnectedStore = affectedEntries.some(({ post, targets }) => {
        const s = resolvePostStore(post, targets);
        return Boolean(s?.shopify?.connected && s.shopify.enabled);
      });
      if (anyConnectedStore) {
        setShorteningAll(true);
        try {
          const { updatedMap, shortenedCount } = await shortenLinksMapByPost(next, affectedEntries);
          setLinkByPostId(updatedMap);
          setBulkLinkToolMode('NONE');
          setBulkLinksRaw('');
          toast.success(
            `Đã điền ${applied} link và rút gọn tự động ${shortenedCount} link sang /s/!`,
          );
          return;
        } catch (err) {
          setLinkByPostId(next);
          toast.error(`Đã điền ${applied} link gốc nhưng lỗi rút gọn /s/: ${getErrorMessage(err)}`);
          return;
        } finally {
          setShorteningAll(false);
        }
      }
    }

    setLinkByPostId(next);
    setBulkLinkToolMode('NONE');
    setBulkLinksRaw('');
    toast.success(
      `Đã điền tự động ${applied}/${displayedPosts.length} link theo thứ tự bài đang hiển thị.`,
    );
  }

  async function handleSubmit() {
    if (!templateText.trim()) {
      toast.warning('Vui lòng chọn mẫu câu hoặc nhập nội dung bình luận.');
      return;
    }
    if (selectedTargetIds.length === 0) {
      toast.warning('Vui lòng chọn ít nhất 1 kênh bài đăng để nhận bình luận.');
      return;
    }
    if (missingLinkPostIds.length > 0) {
      toast.warning(
        `Còn ${missingLinkPostIds.length} bài viết chưa điền biến {link}. Vui lòng nhập đủ link hoặc bỏ tích bài đó.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const targetIdsByMessage = new Map<string, string[]>();
      for (const { post, targets } of postsWithTargets) {
        for (const target of targets) {
          if (!selectedTargetIds.includes(target.id)) continue;
          const postLink = (linkByPostId[post.id] ?? '').trim();
          const postTitle = (post.title || target.title || '').trim();
          let rendered = templateText.trim();
          if (rendered.includes('{link}')) {
            rendered = rendered.replaceAll('{link}', postLink);
          }
          if (rendered.includes('{title}')) {
            rendered = rendered.replaceAll('{title}', postTitle);
          }
          if (autoAttachUtm) {
            rendered = attachUtmToUrlsInText(rendered, target.platform);
          }
          const finalMessage = rendered.trim();
          if (!finalMessage) continue;
          const group = targetIdsByMessage.get(finalMessage) ?? [];
          group.push(target.id);
          targetIdsByMessage.set(finalMessage, group);
        }
      }

      const responses = await Promise.all(
        Array.from(targetIdsByMessage.entries()).map(([msg, ids]) =>
          commentsApi.bulkCreatePlatformComments(workspaceId, ids, msg),
        ),
      );

      const allResults = responses.flatMap((r) => r.results);
      const okCount = allResults.filter((r) => r.queued).length;
      const failItems = allResults.filter((r) => !r.queued);

      if (okCount > 0 && failItems.length === 0) {
        toast.success(`Đã đưa ${okCount} comment chính chủ vào hàng đợi gửi lên các kênh!`);
      } else if (okCount > 0 && failItems.length > 0) {
        toast.warning(
          `Đã xếp hàng ${okCount}/${allResults.length} kênh (${failItems.length} lỗi: ${failItems[0]?.errorMessage ?? ''}).`,
        );
      } else {
        toast.error(failItems[0]?.errorMessage ?? 'Không thể gửi comment lên nền tảng.');
        return;
      }

      onSubmitted?.();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const visibleTemplates = showAllStoreTemplates
    ? [...primaryTemplates, ...extraTemplates]
    : primaryTemplates;

  const nonZeroMediaOptionCount = [
    mediaPostCounts.VIDEO > 0,
    mediaPostCounts.IMAGE > 0,
    mediaPostCounts.NONE > 0,
  ].filter(Boolean).length;

  const isStoreLocked = Boolean(lockedStoreId) || storeCatalog.length <= 1;
  const isPlatformLocked = platformFacet.supported.length <= 1 && platformFilter === 'ALL';
  const isMediaLocked = nonZeroMediaOptionCount <= 1 && mediaFilter === 'ALL';

  const singleMediaLabel =
    mediaPostCounts.VIDEO > 0
      ? `Media: Video (${mediaPostCounts.VIDEO})`
      : mediaPostCounts.IMAGE > 0
        ? `Media: Hình ảnh (${mediaPostCounts.IMAGE})`
        : mediaPostCounts.NONE > 0
          ? `Media: Không media (${mediaPostCounts.NONE})`
          : 'Media: Tất cả (0)';

  const singlePlatformEntry = platformFacet.supported[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-2 backdrop-blur-[1px] sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl lg:h-[88vh]">
        {/* HEADER */}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3.5 sm:px-6">
          <div>
            <h2 className="text-base font-bold text-slate-950 sm:text-lg">
              Comment chính chủ đa kênh &amp; gắn biến {'{link}'} theo bài
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Gửi cùng 1 mẫu bình luận lên FB, IG, YT và tự thay biến{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-semibold text-slate-800">
                {'{link}'}
              </code>{' '}
              riêng cho từng bài đăng.
            </p>
          </div>
          <button
            aria-label="Đóng"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* RESPONSIVE 2-COLUMN BODY */}
        <div className="min-h-0 flex-1 divide-y divide-slate-200 overflow-y-auto lg:grid lg:grid-cols-12 lg:divide-x lg:divide-y-0 lg:overflow-hidden">
          {/* LEFT COLUMN: TEMPLATE COMPOSER & LIVE PREVIEW */}
          <div className="space-y-4 bg-slate-50/60 p-4 sm:p-5 lg:col-span-5 lg:min-h-0 lg:overflow-y-auto">
            <section className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-800">
                  1. Nội dung bình luận chung
                </span>
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-700"
                  title="Tự động nối thêm ?utm_source=fb/yt/ig&utm_medium=cmt vào link của từng kênh tương ứng"
                >
                  <input
                    checked={autoAttachUtm}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    onChange={(e) => toggleAutoUtm(e.target.checked)}
                    type="checkbox"
                  />
                  <span>Tự gắn UTM theo kênh</span>
                </label>
              </div>

              {selectedDistinctStoreNames.length > 1 ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-2.5 py-2 text-[11px] text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    Đang chọn gộp <strong>{selectedDistinctStoreNames.length} Stores</strong> (
                    {selectedDistinctStoreNames.join(', ')}) — hãy kiểm tra kỹ mã giảm giá &amp;
                    link trong mẫu trước khi gửi.
                  </span>
                </div>
              ) : null}

              {visibleTemplates.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                      <Sparkles className="h-3 w-3 text-brand-600" />
                      Mẫu lưu sẵn:
                    </span>
                    {extraTemplates.length > 0 ? (
                      <button
                        className="text-[11px] font-semibold text-brand-600 hover:underline"
                        onClick={() => setShowAllStoreTemplates((prev) => !prev)}
                        type="button"
                      >
                        {showAllStoreTemplates
                          ? 'Thu gọn mẫu khác'
                          : `+ ${extraTemplates.length} mẫu Store khác`}
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visibleTemplates.map((tpl) => {
                      const normalizedTpl = toVariableTemplateBody(tpl.body).trim();
                      const isActive =
                        Boolean(templateText.trim()) && templateText.trim() === normalizedTpl;
                      return (
                        <button
                          key={tpl.id}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                            isActive
                              ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700'
                          }`}
                          onClick={() => {
                            // Selecting a preset keeps store-switching smart unless user custom-types
                            setIsCustomTypedTemplate(false);
                            setTemplateText(toVariableTemplateBody(tpl.body));
                          }}
                          title={tpl.body}
                          type="button"
                        >
                          {isActive ? <Check className="h-3 w-3 shrink-0" /> : null}
                          <span>{tpl.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <textarea
                  ref={templateTextareaRef}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-xs leading-relaxed text-slate-900 shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  onChange={(e) => {
                    setIsCustomTypedTemplate(true);
                    setTemplateText(e.target.value);
                  }}
                  placeholder={
                    '✈️ Free US Shipping (Worldwide Delivery)\n🏷️ Code: PA10 (Extra 10% OFF)\n🎁 Buy 2 Get 5% OFF | Buy 5+ Get 10% OFF\n🔗 {link}'
                  }
                  rows={5}
                  value={templateText}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">Chèn nhanh biến:</span>
                  <button
                    className="inline-flex items-center gap-1 rounded border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 transition hover:bg-brand-100"
                    onClick={() => insertVariableAtCursor('{link}')}
                    type="button"
                  >
                    + {'{link}'}
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-100"
                    onClick={() => insertVariableAtCursor('{title}')}
                    type="button"
                  >
                    + {'{title}'}
                  </button>
                </div>
              </div>
            </section>

            {/* LIVE PREVIEW PANEL */}
            <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                  <Eye className="h-3.5 w-3.5 text-brand-600" />
                  Xem trước thực tế
                </span>
                {previewSample ? (
                  <span className="max-w-[180px] truncate rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    {PLATFORM_LABELS[previewSample.target.platform]} ·{' '}
                    {previewSample.target.socialAccountName}
                  </span>
                ) : null}
              </div>

              {previewSample && templateText.trim() ? (
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-slate-100 bg-slate-50/80 p-2.5 font-sans text-xs leading-relaxed text-slate-800">
                  {previewSample.rendered}
                </pre>
              ) : (
                <p className="mt-2 text-xs text-slate-400">
                  Chọn mẫu hoặc nhập nội dung để xem trước bình luận thực tế sẽ gửi lên kênh.
                </p>
              )}
            </section>
          </div>

          {/* RIGHT COLUMN: 2-TIER FILTER HEADER + FULL-HEIGHT POST LIST */}
          <div className="flex flex-col bg-white lg:col-span-7 lg:min-h-0 lg:overflow-hidden">
            {/* PINNED 2-TIER TOOLBAR */}
            <div className="shrink-0 space-y-2.5 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
              {/* TIER 1: SCOPE FILTERS (1 crisp horizontal row: Store · Social · Media · Date) */}
              <div
                className={`grid grid-cols-2 gap-2 ${
                  isExplicitSelection ? 'sm:grid-cols-3' : 'sm:grid-cols-4'
                }`}
              >
                {/* 1. Store Select */}
                <select
                  aria-label="Lọc theo Store"
                  className={`h-[34px] w-full truncate rounded-md border px-2 text-xs outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${
                    isStoreLocked
                      ? 'cursor-default border-slate-200 bg-slate-50 font-medium text-slate-600'
                      : storeFilter !== 'ALL'
                        ? 'border-brand-300 bg-brand-50/50 font-semibold text-brand-900'
                        : 'border-slate-300 bg-white font-medium text-slate-700'
                  }`}
                  disabled={isStoreLocked}
                  onChange={(e) => handleChangeStore(e.target.value)}
                  title="Store / Brand đang chọn"
                  value={storeFilter}
                >
                  {lockedStoreId ? (
                    <option value={lockedStoreId}>
                      Store:{' '}
                      {storeCatalog.find((s) => s.id === lockedStoreId)?.name ?? lockedStoreId} (
                      {storeOptionCounts.byStoreId.get(lockedStoreId) ?? 0})
                    </option>
                  ) : (
                    <>
                      {storesWithPosts.map((store) => (
                        <option key={store.id} value={store.id}>
                          Store: {store.name} ({storeOptionCounts.byStoreId.get(store.id) ?? 0})
                        </option>
                      ))}
                      {storesWithPosts.length > 1 ? (
                        <option value="ALL">Tất cả Stores ({storeOptionCounts.total})</option>
                      ) : null}
                      {storeCatalog
                        .filter((store) => (allTimeStoreCounts.get(store.id) ?? 0) === 0)
                        .map((store) => (
                          <option key={store.id} disabled value={store.id}>
                            ── {store.name} (0 bài · chưa có bài đăng)
                          </option>
                        ))}
                    </>
                  )}
                </select>

                {/* 2. Social Platform Select (True visibility + target filter) */}
                <select
                  aria-label="Lọc theo kênh Social"
                  className={`h-[34px] w-full truncate rounded-md border px-2 text-xs outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${
                    isPlatformLocked
                      ? 'cursor-default border-slate-200 bg-slate-50 font-medium text-slate-600'
                      : platformFilter !== 'ALL'
                        ? 'border-brand-300 bg-brand-50/50 font-semibold text-brand-900'
                        : 'border-slate-300 bg-white font-medium text-slate-700'
                  }`}
                  disabled={isPlatformLocked}
                  onChange={(e) =>
                    applyScopeChange(
                      storeFilter,
                      e.target.value as ModalPlatformFilter,
                      mediaFilter,
                      dateWindow,
                      hideCommented,
                    )
                  }
                  title="Lọc ẩn bài theo kênh mạng xã hội"
                  value={platformFilter}
                >
                  {isPlatformLocked && singlePlatformEntry ? (
                    <option value="ALL">
                      Kênh: {PLATFORM_LABELS[singlePlatformEntry[0]]} ({singlePlatformEntry[1]})
                    </option>
                  ) : (
                    <>
                      <option value="ALL">Tất cả kênh ({platformFacet.totalSupported})</option>
                      {platformFacet.supported.map(([pf, count]) => (
                        <option key={pf} value={pf}>
                          {PLATFORM_LABELS[pf]} ({count})
                        </option>
                      ))}
                      {platformFacet.unsupported.map(([pf, count]) => (
                        <option key={pf} disabled value={`unsupported_${pf}`}>
                          ── {PLATFORM_LABELS[pf]} ({count} · ko hỗ trợ API cmt)
                        </option>
                      ))}
                    </>
                  )}
                </select>

                {/* 3. Media Type Select */}
                <select
                  aria-label="Lọc theo loại media"
                  className={`h-[34px] w-full truncate rounded-md border px-2 text-xs outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${
                    isMediaLocked
                      ? 'cursor-default border-slate-200 bg-slate-50 font-medium text-slate-600'
                      : mediaFilter !== 'ALL'
                        ? 'border-brand-300 bg-brand-50/50 font-semibold text-brand-900'
                        : 'border-slate-300 bg-white font-medium text-slate-700'
                  }`}
                  disabled={isMediaLocked}
                  onChange={(e) =>
                    applyScopeChange(
                      storeFilter,
                      platformFilter,
                      e.target.value as ModalMediaFilter,
                      dateWindow,
                      hideCommented,
                    )
                  }
                  title="Lọc bài đăng theo loại media (Video / Hình ảnh)"
                  value={mediaFilter}
                >
                  {isMediaLocked ? (
                    <option value="ALL">{singleMediaLabel}</option>
                  ) : (
                    <>
                      <option value="ALL">Tất cả media ({mediaPostCounts.ALL})</option>
                      {mediaPostCounts.VIDEO > 0 || mediaFilter === 'VIDEO' ? (
                        <option value="VIDEO">Video ({mediaPostCounts.VIDEO})</option>
                      ) : null}
                      {mediaPostCounts.IMAGE > 0 || mediaFilter === 'IMAGE' ? (
                        <option value="IMAGE">Hình ảnh ({mediaPostCounts.IMAGE})</option>
                      ) : null}
                      {mediaPostCounts.NONE > 0 || mediaFilter === 'NONE' ? (
                        <option value="NONE">Không media ({mediaPostCounts.NONE})</option>
                      ) : null}
                    </>
                  )}
                </select>

                {/* 4. Date Window Select (Hidden when opening from explicit checkbox selection) */}
                {!isExplicitSelection ? (
                  <select
                    aria-label="Lọc theo khoảng ngày đăng"
                    className={`h-[34px] w-full truncate rounded-md border px-2 text-xs outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${
                      dateWindow !== 'ALL'
                        ? 'border-brand-300 bg-brand-50/50 font-semibold text-brand-900'
                        : 'border-slate-300 bg-white font-medium text-slate-700'
                    }`}
                    onChange={(e) =>
                      applyScopeChange(
                        storeFilter,
                        platformFilter,
                        mediaFilter,
                        e.target.value as DateWindowKey,
                        hideCommented,
                      )
                    }
                    title="Khoảng thời gian đăng bài"
                    value={dateWindow}
                  >
                    <option
                      disabled={windowTargetCounts['3D'] === 0 && dateWindow !== '3D'}
                      value="3D"
                    >
                      3 ngày qua ({windowTargetCounts['3D']})
                    </option>
                    <option
                      disabled={windowTargetCounts['7D'] === 0 && dateWindow !== '7D'}
                      value="7D"
                    >
                      7 ngày qua ({windowTargetCounts['7D']})
                    </option>
                    <option
                      disabled={windowTargetCounts['14D'] === 0 && dateWindow !== '14D'}
                      value="14D"
                    >
                      14 ngày qua ({windowTargetCounts['14D']})
                    </option>
                    <option value="ALL">Tất cả lịch sử ({windowTargetCounts.ALL})</option>
                  </select>
                ) : null}
              </div>

              {/* TIER 2: ACTION & SAFETY BAR */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-700">
                    Đã chọn{' '}
                    <strong className="text-slate-950">
                      {selectedTargetIds.length}/{allTargets.length}
                    </strong>{' '}
                    kênh
                  </span>
                  <span className="text-slate-300">·</span>
                  <button
                    className="text-[11px] font-semibold text-brand-600 hover:underline"
                    onClick={() => setSelectedTargetIds(allTargets.map((t) => t.id))}
                    type="button"
                  >
                    Chọn hết
                  </button>
                  <span className="text-slate-300">·</span>
                  <button
                    className="text-[11px] font-semibold text-slate-500 hover:underline"
                    onClick={() => setSelectedTargetIds([])}
                    type="button"
                  >
                    Bỏ chọn
                  </button>

                  {platformFacet.unsupported.length > 0 ? (
                    <span
                      className="inline-flex cursor-help items-center gap-1 rounded border border-dashed border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500"
                      title={platformFacet.unsupported
                        .map(
                          ([pf, count]) =>
                            `${PLATFORM_LABELS[pf]} (${count} bài): API chính thức không hỗ trợ tạo bình luận tự động.`,
                        )
                        .join(' ')}
                    >
                      <Info className="h-3 w-3 text-slate-400" />
                      {platformFacet.unsupported
                        .map(([pf, count]) => `${platformShortLabel(pf)} (${count}) ko cmt`)
                        .join(', ')}
                    </span>
                  ) : null}

                  {commentedTargetsCount > 0 ? (
                    <button
                      className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold transition ${
                        hideCommented
                          ? 'border-amber-500 bg-amber-500 text-white shadow-sm'
                          : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      }`}
                      onClick={() =>
                        applyScopeChange(
                          storeFilter,
                          platformFilter,
                          mediaFilter,
                          dateWindow,
                          !hideCommented,
                        )
                      }
                      title="Ẩn và bỏ chọn các kênh bài đăng đã có bình luận trước đó để tránh gửi trùng"
                      type="button"
                    >
                      <MessageSquareOff className="h-3 w-3" />
                      {hideCommented
                        ? `Đã ẩn kênh có cmt (${commentedTargetsCount})`
                        : `Ẩn kênh đã có cmt (${commentedTargetsCount})`}
                    </button>
                  ) : null}

                  {usesLinkVariable && (missingLinkPostIds.length > 0 || onlyMissingLinks) ? (
                    <button
                      className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold transition ${
                        onlyMissingLinks
                          ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                          : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      }`}
                      onClick={handleToggleOnlyMissingLinks}
                      type="button"
                    >
                      <AlertCircle className="h-3 w-3" />
                      {onlyMissingLinks
                        ? 'Đang lọc thiếu link (Hiện hết)'
                        : `Thiếu {link} (${missingLinkPostIds.length})`}
                    </button>
                  ) : null}
                </div>

                {displayedPosts.length > 0 && usesLinkVariable ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 text-[11px] font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
                      disabled={shorteningAll}
                      onClick={() => void handleShortenDisplayedPostLinks()}
                      title="Tự động lọc rác tracking (fbclid, _pos, _ss...) và tạo link ngắn chính chủ https://tenstore.com/s/... qua Shopify"
                      type="button"
                    >
                      <Zap className="h-3 w-3 text-emerald-600" />
                      {shorteningAll ? 'Đang rút gọn...' : 'Rút gọn link (/s/)'}
                    </button>
                    {displayedPosts.length > 1 ? (
                      <>
                        <button
                          className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition ${
                            bulkLinkToolMode === 'SHARED'
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                          onClick={() =>
                            setBulkLinkToolMode((prev) => (prev === 'SHARED' ? 'NONE' : 'SHARED'))
                          }
                          type="button"
                        >
                          <Link2 className="h-3 w-3 text-brand-600" />1 link chung
                        </button>
                        <button
                          className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition ${
                            bulkLinkToolMode === 'LINES'
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                          onClick={() =>
                            setBulkLinkToolMode((prev) => (prev === 'LINES' ? 'NONE' : 'LINES'))
                          }
                          type="button"
                        >
                          <ClipboardPaste className="h-3 w-3 text-brand-600" />
                          Dán Sheet
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* Collapsible Bulk Link Fill Panel */}
              {bulkLinkToolMode === 'SHARED' && usesLinkVariable ? (
                <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-2.5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      autoFocus
                      className="h-8 flex-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900 focus:border-brand-500 focus:outline-none"
                      onChange={(e) => setSharedLinkInput(e.target.value)}
                      placeholder="Dán 1 link sản phẩm dùng chung cho các bài đang hiển thị (https://...)"
                      type="url"
                      value={sharedLinkInput}
                    />
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SecondaryButton
                        className="h-8 shrink-0 border-emerald-300 bg-emerald-50 px-2.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                        disabled={!sharedLinkInput.trim() || shorteningShared}
                        onClick={() => void shortenAndApplySharedLinkToAll()}
                        type="button"
                      >
                        <Zap className="h-3.5 w-3.5 text-emerald-600" />
                        {shorteningShared ? 'Đang rút gọn...' : 'Rút gọn /s/ & Áp dụng'}
                      </SecondaryButton>
                      <SecondaryButton
                        className="h-8 shrink-0 border-brand-300 bg-white px-3 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                        disabled={!sharedLinkInput.trim() || shorteningShared}
                        onClick={applySharedLinkToAll}
                        type="button"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Áp dụng ({displayedPosts.length} bài)
                      </SecondaryButton>
                      <button
                        aria-label="Đóng khung điền link chung"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200/60 hover:text-slate-700"
                        onClick={() => setBulkLinkToolMode('NONE')}
                        type="button"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {bulkLinkToolMode === 'LINES' && usesLinkVariable ? (
                <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-2.5">
                  <p className="text-[11px] text-slate-600">
                    Copy cột link từ Excel / Google Sheet và dán vào dưới đây — mỗi dòng sẽ gán lần
                    lượt cho <strong>{displayedPosts.length} bài đang hiển thị</strong> (#1 → #
                    {displayedPosts.length}):
                  </p>
                  <textarea
                    autoFocus
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-brand-500 focus:outline-none"
                    onChange={(e) => setBulkLinksRaw(e.target.value)}
                    placeholder={
                      'https://preaureum.com/products/bag-1\nhttps://preaureum.com/products/bag-2'
                    }
                    rows={3}
                    value={bulkLinksRaw}
                  />
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-emerald-800">
                      <input
                        checked={autoShortenBulkLines}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        onChange={(e) => setAutoShortenBulkLines(e.target.checked)}
                        type="checkbox"
                      />
                      <span>⚡ Tự rút gọn sang /s/... nếu Store đã gắn Shopify</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200/70"
                        onClick={() => setBulkLinkToolMode('NONE')}
                        type="button"
                      >
                        Đóng
                      </button>
                      <SecondaryButton
                        className="h-7 border-brand-300 bg-white px-3 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                        disabled={!bulkLinksRaw.trim() || shorteningAll}
                        onClick={() => void applyBulkLinesToPosts()}
                        type="button"
                      >
                        <Check className="h-3.5 w-3.5" />
                        {shorteningAll ? 'Đang điền & rút gọn...' : 'Điền theo thứ tự dòng'}
                      </SecondaryButton>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* FULL-HEIGHT SCROLLABLE POST LIST */}
            <div className="divide-y divide-slate-200 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {displayedPosts.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  {onlyMissingLinks ? (
                    <div className="space-y-2">
                      <p className="font-semibold text-emerald-700">
                        ✓ Tất cả các bài đang chọn đều đã có đủ link sản phẩm!
                      </p>
                      <button
                        className="font-semibold text-brand-600 hover:underline"
                        onClick={() => {
                          setOnlyMissingLinks(false);
                          setPinnedMissingPostIds([]);
                        }}
                        type="button"
                      >
                        Quay lại xem toàn bộ bài viết ({postsWithTargets.length})
                      </button>
                    </div>
                  ) : hideCommented && commentedTargetsCount > 0 ? (
                    <div className="space-y-2">
                      <p className="font-semibold text-slate-700">
                        Tất cả {commentedTargetsCount} kênh trong phạm vi này đều đã có bình luận
                        trước đó.
                      </p>
                      <button
                        className="font-semibold text-brand-600 hover:underline"
                        onClick={() =>
                          applyScopeChange(
                            storeFilter,
                            platformFilter,
                            mediaFilter,
                            dateWindow,
                            false,
                          )
                        }
                        type="button"
                      >
                        Hiện lại các kênh đã có bình luận ({commentedTargetsCount})
                      </button>
                    </div>
                  ) : (
                    'Không có bài đăng nào hỗ trợ API comment (Facebook / Instagram / YouTube) khớp bộ lọc hiện tại.'
                  )}
                </div>
              ) : (
                displayedPosts.map(({ post, targets, originalIndex }) => {
                  const storeBadge = post.store ?? targets.find((t) => t.store)?.store ?? null;
                  const postStore = resolvePostStore(post, targets);
                  const postStoreHasShopify = Boolean(
                    postStore?.shopify?.connected && postStore.shopify.enabled,
                  );
                  const postHasAnyChecked = targets.some((t) => selectedTargetIds.includes(t.id));
                  const linkValue = linkByPostId[post.id] ?? '';
                  const alreadyShort = isStoreShortLink(linkValue, postStore);
                  const isMissingLink = usesLinkVariable && postHasAnyChecked && !linkValue.trim();
                  const primaryExternalUrl =
                    targets.find((t) => t.externalUrl)?.externalUrl ?? null;
                  const isPreviewFocused = previewSample?.post.id === post.id;

                  return (
                    <div
                      key={post.id}
                      className={`px-4 py-3 transition sm:px-5 ${
                        postHasAnyChecked ? 'bg-white' : 'bg-slate-50/70 opacity-65'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <ModalPostThumb externalUrl={primaryExternalUrl} post={post} />

                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                                #{originalIndex + 1}
                              </span>
                              {storeBadge ? (
                                <span
                                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                                  style={{ backgroundColor: storeBadge.color ?? '#2563eb' }}
                                >
                                  {storeBadge.name}
                                </span>
                              ) : null}
                              <p className="truncate text-xs font-semibold text-slate-900">
                                {resolveReadablePostLabel(post, targets)}
                              </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
                                  isPreviewFocused
                                    ? 'bg-brand-50 text-brand-700'
                                    : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                                }`}
                                onClick={() => setPreviewPostId(post.id)}
                                title="Xem trước bình luận của bài này ở cột bên trái"
                                type="button"
                              >
                                <Eye className="h-3 w-3" />
                                <span className="hidden sm:inline">Preview</span>
                              </button>
                              {primaryExternalUrl ? (
                                <a
                                  className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline"
                                  href={primaryExternalUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                  title="Mở bài viết gốc để xem đúng mẫu sản phẩm trong video/ảnh"
                                >
                                  Xem bài
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : null}
                            </div>
                          </div>

                          {/* Social channels for this post */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {targets.map((pp) => {
                              const checked = selectedTargetIds.includes(pp.id);
                              const cmtCount = pp.commentCount ?? 0;
                              return (
                                <label
                                  key={pp.id}
                                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition ${
                                    checked
                                      ? 'border-brand-300 bg-brand-50/70 text-brand-900'
                                      : 'border-slate-200 bg-white text-slate-500'
                                  }`}
                                >
                                  <input
                                    checked={checked}
                                    className="h-3 w-3 rounded border-slate-300 text-brand-600"
                                    onChange={(e) => {
                                      setSelectedTargetIds((prev) =>
                                        e.target.checked
                                          ? [...prev, pp.id]
                                          : prev.filter((id) => id !== pp.id),
                                      );
                                    }}
                                    type="checkbox"
                                  />
                                  <span className="font-bold">
                                    {platformShortLabel(pp.platform)}
                                  </span>
                                  <span className="max-w-36 truncate">{pp.socialAccountName}</span>
                                  {cmtCount > 0 ? (
                                    <span
                                      className="rounded border border-amber-200 bg-amber-50 px-1 text-[10px] font-semibold text-amber-800"
                                      title="Kênh này đã có bình luận trước đó"
                                    >
                                      {cmtCount} cmt
                                    </span>
                                  ) : null}
                                </label>
                              );
                            })}
                          </div>

                          {/* Per-post {link} input */}
                          {usesLinkVariable ? (
                            <div>
                              <div className="relative flex items-center">
                                <Link2 className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
                                <input
                                  className={`w-full rounded-md border py-1.5 pl-8 ${
                                    linkValue.trim() ? 'pr-24' : 'pr-7'
                                  } text-xs text-slate-900 transition focus:outline-none ${
                                    isMissingLink
                                      ? 'border-amber-400 bg-amber-50/40 focus:border-amber-500'
                                      : 'border-slate-300 bg-white focus:border-brand-500'
                                  }`}
                                  onFocus={() => setPreviewPostId(post.id)}
                                  onChange={(e) =>
                                    setLinkByPostId((prev) => ({
                                      ...prev,
                                      [post.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="Dán link sản phẩm riêng cho bài đăng này (https://...)"
                                  type="url"
                                  value={linkValue}
                                />
                                {linkValue.trim() ? (
                                  <div className="absolute right-1.5 flex items-center gap-1">
                                    {alreadyShort ? (
                                      <span
                                        className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
                                        title="Link này đã là link ngắn chính chủ /s/"
                                      >
                                        ✓ /s/
                                      </span>
                                    ) : postStore ? (
                                      <button
                                        className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold transition disabled:opacity-50 ${
                                          postStoreHasShopify
                                            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                                            : 'border-dashed border-slate-300 bg-slate-50 text-slate-600 hover:border-emerald-300 hover:text-emerald-800'
                                        }`}
                                        disabled={shorteningPostId === post.id || shorteningAll}
                                        onClick={() =>
                                          void handleShortenSinglePostLink(post, targets)
                                        }
                                        title={
                                          postStoreHasShopify
                                            ? `Rút gọn sang https://${postStore.shopify?.publicDomain}${postStore.shopify?.shortPathPrefix}...`
                                            : `Gắn Shopify cho Store "${postStore.name}" để rút gọn link /s/`
                                        }
                                        type="button"
                                      >
                                        <Zap className="h-2.5 w-2.5 text-emerald-600" />
                                        <span>
                                          {shorteningPostId === post.id
                                            ? '...'
                                            : postStoreHasShopify
                                              ? '/s/'
                                              : '+ /s/'}
                                        </span>
                                      </button>
                                    ) : null}
                                    <button
                                      aria-label="Xóa link bài này"
                                      className="inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                                      onClick={() =>
                                        setLinkByPostId((prev) => ({ ...prev, [post.id]: '' }))
                                      }
                                      type="button"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                              {isMissingLink ? (
                                <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
                                  <AlertCircle className="h-3 w-3" />
                                  Chưa nhập biến {'{link}'} cho bài này
                                </p>
                              ) : autoAttachUtm && linkValue.trim() && postHasAnyChecked ? (
                                <p className="mt-0.5 text-[10px] text-emerald-700">
                                  ✓ Tự gắn UTM:{' '}
                                  {Array.from(
                                    new Set(
                                      targets
                                        .filter((t) => selectedTargetIds.includes(t.id))
                                        .map((t) => t.platform),
                                    ),
                                  )
                                    .map(
                                      (pf) =>
                                        `${platformShortLabel(pf)} (?utm_source=${platformUtmSource(pf)}&utm_medium=cmt)`,
                                    )
                                    .join(' · ')}
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/80 px-4 py-3 sm:px-6">
          <div className="text-xs text-slate-600">
            {missingLinkPostIds.length > 0 ? (
              <button
                className="inline-flex items-center gap-1.5 font-semibold text-amber-700 hover:underline"
                onClick={() => {
                  if (!onlyMissingLinks) {
                    setPinnedMissingPostIds(missingLinkPostIds);
                    setOnlyMissingLinks(true);
                  }
                }}
                title="Bấm để lọc xem các bài đang thiếu link"
                type="button"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>
                  Còn {missingLinkPostIds.length} bài chưa điền link sản phẩm {'{link}'}
                </span>
              </button>
            ) : (
              <span>
                Sẵn sàng gửi lên <strong>{selectedTargetIds.length}</strong> kênh thuộc{' '}
                <strong>{activePostsWithSelectedTargets.length}</strong> bài viết.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={onClose} type="button">
              Hủy
            </SecondaryButton>
            <PrimaryButton
              busy={submitting}
              disabled={
                submitting ||
                !templateText.trim() ||
                selectedTargetIds.length === 0 ||
                missingLinkPostIds.length > 0
              }
              onClick={() => void handleSubmit()}
              type="button"
            >
              <Send className="h-3.5 w-3.5" />
              <span>Gửi comment ({selectedTargetIds.length} kênh)</span>
            </PrimaryButton>
          </div>
        </footer>
      </div>

      {shopifySetupStore ? (
        <StoreSettingsModal
          initialTab="shopify"
          onClose={() => setShopifySetupStore(null)}
          onSaved={async () => {
            const refreshed = await storesApi.list(workspaceId);
            setLocalStores(refreshed.items);
            queryClient.setQueryData(workspaceQueryKeys.stores(workspaceId), refreshed);
            const updated = refreshed.items.find((s) => s.id === shopifySetupStore.id) ?? null;
            if (updated) {
              setShopifySetupStore(updated);
            }
          }}
          store={storeById.get(shopifySetupStore.id) ?? shopifySetupStore}
          workspaceId={workspaceId}
        />
      ) : null}
    </div>
  );
}

function ModalPostThumb({
  post,
  externalUrl,
}: {
  post: ContentPostView;
  externalUrl?: string | null;
}) {
  const asset = getEffectivePostMedia(post)[0];
  const content = (() => {
    if (!asset) {
      return (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[10px] font-medium text-slate-400">
          No img
        </div>
      );
    }
    const sources =
      asset.type === 'VIDEO' && asset.status !== 'ARCHIVED'
        ? mediaThumbnailSources(asset)
        : mediaPreviewSources(asset);
    if (sources.length === 0) {
      return (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[10px] font-semibold text-slate-500">
          {asset.type}
        </div>
      );
    }
    return (
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100">
        <FallbackImage
          alt={post.title ?? 'Post thumbnail'}
          className="h-full w-full object-cover"
          sources={sources}
        />
        {asset.type === 'VIDEO' ? (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-slate-950/75 px-1 py-px text-[8px] font-bold tracking-tight text-white">
            VID
          </span>
        ) : null}
      </div>
    );
  })();

  if (externalUrl) {
    return (
      <a
        className="shrink-0 transition hover:opacity-85"
        href={externalUrl}
        rel="noreferrer"
        target="_blank"
        title="Bấm để mở xem bài viết gốc"
      >
        {content}
      </a>
    );
  }
  return content;
}
