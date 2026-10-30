'use client';

import {
  capabilityBlockReason,
  hasPermission,
  isCapabilityUsable,
  type Platform,
} from '@socialhub/shared';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Tag,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { useWorkspaceEventSubscription } from '@/components/workspace-events-provider';
import { commentsApi, workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import {
  AUTO_UTM_STORAGE_KEY,
  attachUtmToUrlsInText,
  hasEligibleStoreUrl,
  isTemplateMatchingStoreSlug,
  platformShortLabel,
  platformUtmSource,
} from '@/lib/comment-templates';
import { getErrorMessage } from '@/lib/errors';
import type {
  CommentTagView,
  CommentView,
  ContentPostView,
  PlatformCapabilitiesView,
  ReplyTemplateView,
  WorkspaceMember,
} from '@/lib/types';

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED'] as const;
const TAG_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#64748b'] as const;

interface OptimisticTopComment {
  id: string;
  jobId?: string;
  platformPostId: string;
  platform: Platform;
  socialAccountName: string;
  message: string;
  createdAt: string;
  status: 'SENDING' | 'FAILED';
  errorMessage?: string;
}

interface PostCommentsDrawerProps {
  workspaceId: string;
  post: ContentPostView | null;
  capabilityByPlatform: Partial<Record<Platform, PlatformCapabilitiesView>>;
  onClose: () => void;
  onPostUpdated?: () => void;
}

export function PostCommentsDrawer({
  workspaceId,
  post,
  capabilityByPlatform,
  onClose,
  onPostUpdated,
}: PostCommentsDrawerProps) {
  const auth = useAuth();
  const toast = useToast();
  const role = auth.activeWorkspace?.role;
  const canReply = role ? hasPermission(role, 'comment:reply') : false;
  const canModerate = role ? hasPermission(role, 'comment:moderate') : false;
  const canAssign = role ? hasPermission(role, 'comment:assign') : false;

  const [comments, setComments] = useState<CommentView[]>([]);
  const [tags, setTags] = useState<CommentTagView[]>([]);
  const [templates, setTemplates] = useState<ReplyTemplateView[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);

  const [activePlatformPostId, setActivePlatformPostId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Selection for bulk reply
  const [selectedCommentIds, setSelectedCommentIds] = useState<Set<string>>(() => new Set());
  const [bulkReplyText, setBulkReplyText] = useState('');

  // Bottom composer: comment directly on the post (top-level official comment)
  const [newPostCommentText, setNewPostCommentText] = useState('');
  const [postCommentTargetIds, setPostCommentTargetIds] = useState<string[]>([]);
  const [optimisticTopComments, setOptimisticTopComments] = useState<OptimisticTopComment[]>([]);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateBody, setNewTemplateBody] = useState('');
  const [autoAttachUtm, setAutoAttachUtm] = useState<boolean>(true);
  const postCommentTextareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  function toggleAutoAttachUtm(checked: boolean) {
    setAutoAttachUtm(checked);
    try {
      window.localStorage.setItem(AUTO_UTM_STORAGE_KEY, checked ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }

  // Expanded comment detail (tags, notes, assignment)
  const [expandedDetailCommentId, setExpandedDetailCommentId] = useState<string | null>(null);

  const publishedTargets = useMemo(
    () =>
      (post?.platformPosts ?? []).filter(
        (pp) => pp.status === 'PUBLISHED' && Boolean(pp.externalPostId),
      ),
    [post],
  );

  const defaultProductLinkUrl = useMemo(() => {
    if (!post) return null;
    if (post.linkUrl?.trim()) return post.linkUrl.trim();
    const targetWithLink = post.platformPosts.find((pp) => pp.linkUrl?.trim());
    return targetWithLink?.linkUrl?.trim() ?? null;
  }, [post]);

  const activeStoreSlug = useMemo(() => {
    if (!post) return null;
    if (post.store?.slug) return post.store.slug.toLowerCase();
    const targetWithStore = post.platformPosts.find((pp) => pp.store?.slug);
    return targetWithStore?.store?.slug?.toLowerCase() ?? null;
  }, [post]);

  const postStoreId = useMemo(() => {
    if (!post) return undefined;
    return post.storeId ?? post.platformPosts.find((pp) => pp.storeId)?.storeId ?? undefined;
  }, [post]);

  const isStoreMatchedTemplate = useCallback(
    (templateName: string): boolean => isTemplateMatchingStoreSlug(templateName, activeStoreSlug),
    [activeStoreSlug],
  );

  const sortedTemplates = useMemo(() => {
    if (!activeStoreSlug) return templates;
    return [...templates].sort((a, b) => {
      const aMatch = isStoreMatchedTemplate(a.name) ? 1 : 0;
      const bMatch = isStoreMatchedTemplate(b.name) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return a.name.localeCompare(b.name);
    });
  }, [activeStoreSlug, isStoreMatchedTemplate, templates]);

  useEffect(() => {
    if (!post) return;
    setActivePlatformPostId('ALL');
    setStatusFilter('');
    setTagFilter('');
    setSearchQuery('');
    setSelectedCommentIds(new Set());
    setExpandedDetailCommentId(null);
    setOptimisticTopComments([]);
    const defaultTargets = post.platformPosts
      .filter((pp) => pp.status === 'PUBLISHED' && Boolean(pp.externalPostId))
      .map((pp) => pp.id);
    setPostCommentTargetIds(defaultTargets);
  }, [post]);

  const loadComments = useCallback(
    async (silent = false) => {
      if (!post) return;
      if (!silent) setLoading(true);
      try {
        const res = await commentsApi.list(workspaceId, {
          contentPostId: post.id,
          platformPostId: activePlatformPostId !== 'ALL' ? activePlatformPostId : undefined,
          status: statusFilter || undefined,
          tagId: tagFilter || undefined,
          q: searchQuery.trim() || undefined,
          limit: 200,
        });
        setComments(res.items);
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [activePlatformPostId, post, searchQuery, statusFilter, tagFilter, toast, workspaceId],
  );

  const loadStaticMeta = useCallback(async () => {
    if (!post) return;
    try {
      const [tagRes, tplRes, memberRes] = await Promise.all([
        commentsApi.listTags(workspaceId),
        commentsApi.listTemplates(workspaceId, postStoreId),
        workspaceApi.members(workspaceId),
      ]);
      setTags(tagRes.items);
      setTemplates(tplRes.items);
      setMembers(memberRes.items);
    } catch {
      // ignore non-critical metadata errors
    }
  }, [post, postStoreId, workspaceId]);

  useEffect(() => {
    if (!post) return;
    void loadComments();
  }, [post, loadComments]);

  useEffect(() => {
    if (!post) return;
    void loadStaticMeta();
  }, [post, loadStaticMeta]);

  // Build parent -> children map & root comments list
  const { rootComments, childrenByParentId, countsByStatus } = useMemo(() => {
    const childMap = new Map<string, CommentView[]>();
    const byId = new Set(comments.map((c) => c.id));
    const roots: CommentView[] = [];
    const statusMap: Record<string, number> = { OPEN: 0, PENDING: 0, RESOLVED: 0 };

    for (const c of comments) {
      statusMap[c.status] = (statusMap[c.status] ?? 0) + 1;
      if (c.parentId && byId.has(c.parentId)) {
        const list = childMap.get(c.parentId) ?? [];
        list.push(c);
        childMap.set(c.parentId, list);
      } else {
        roots.push(c);
      }
    }

    roots.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
    for (const list of childMap.values()) {
      list.sort((a, b) => new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime());
    }

    return { rootComments: roots, childrenByParentId: childMap, countsByStatus: statusMap };
  }, [comments]);

  const { connected: sseConnected } = useWorkspaceEventSubscription((event) => {
    if (!post) return;
    const targetIds = new Set(post.platformPosts.map((pp) => pp.id));

    if (
      event.type === 'comment.created' &&
      (event.contentPostId === post.id ||
        (event.platformPostId && targetIds.has(event.platformPostId)))
    ) {
      setOptimisticTopComments((prev) => {
        if (event.jobId && prev.some((item) => item.jobId === event.jobId)) {
          return prev.filter((item) => item.jobId !== event.jobId);
        }
        let removedOne = false;
        return prev.filter((item) => {
          if (
            !removedOne &&
            item.status === 'SENDING' &&
            item.platformPostId === event.platformPostId
          ) {
            removedOne = true;
            return false;
          }
          return true;
        });
      });
      void loadComments(true);
      onPostUpdated?.();
      return;
    }

    if (
      event.type === 'comment.create_failed' &&
      event.platformPostId &&
      targetIds.has(event.platformPostId)
    ) {
      setOptimisticTopComments((prev) =>
        prev.map((item) => {
          const matchesJob = Boolean(event.jobId && item.jobId === event.jobId);
          const matchesTarget =
            !event.jobId &&
            item.status === 'SENDING' &&
            item.platformPostId === event.platformPostId;
          if (!matchesJob && !matchesTarget) return item;
          return {
            ...item,
            status: 'FAILED',
            errorMessage: event.errorMessage ?? 'Không thể đăng bình luận lên nền tảng.',
          };
        }),
      );
      return;
    }

    if (event.type === 'comment.replied') {
      const commentIds = new Set(comments.map((c) => c.id));
      if (
        event.contentPostId === post.id ||
        (event.platformPostId && targetIds.has(event.platformPostId)) ||
        (event.commentId && commentIds.has(event.commentId))
      ) {
        void loadComments(true);
        onPostUpdated?.();
      }
      return;
    }

    if (
      (event.type === 'comments.synced' ||
        event.type === 'comment.moderated' ||
        event.type === 'comment.moderation_failed') &&
      (!event.platformPostId || targetIds.has(event.platformPostId))
    ) {
      void loadComments(true);
      onPostUpdated?.();
    }
  });

  const visibleOptimisticComments = useMemo(() => {
    return optimisticTopComments.filter((opt) => {
      if (activePlatformPostId !== 'ALL' && opt.platformPostId !== activePlatformPostId) {
        return false;
      }
      if (opt.status === 'SENDING') {
        const optCreatedMs = Date.parse(opt.createdAt) - 10_000;
        const alreadyPersisted = comments.some(
          (c) =>
            c.isFromPage &&
            c.platformPostId === opt.platformPostId &&
            (c.message ?? '').trim() === opt.message.trim() &&
            Date.parse(c.postedAt) >= optCreatedMs,
        );
        if (alreadyPersisted) return false;
      }
      return true;
    });
  }, [activePlatformPostId, comments, optimisticTopComments]);

  if (!post) return null;

  async function handleSyncCommentsFromPlatform() {
    if (publishedTargets.length === 0) {
      toast.warning('Bài viết này chưa có bản đăng PUBLISHED nào trên nền tảng để kéo comment.');
      return;
    }

    const targetsToSync =
      activePlatformPostId === 'ALL'
        ? publishedTargets
        : publishedTargets.filter((t) => t.id === activePlatformPostId);

    const usableTargets = targetsToSync.filter((t) => {
      const cap = capabilityByPlatform[t.platform]?.capabilities.readComments;
      return !cap || isCapabilityUsable(cap);
    });

    if (usableTargets.length === 0) {
      const firstBlocked = targetsToSync[0];
      const cap = firstBlocked
        ? capabilityByPlatform[firstBlocked.platform]?.capabilities.readComments
        : undefined;
      toast.warning(
        (cap && capabilityBlockReason(cap)) ||
          'Nền tảng này chưa hỗ trợ đồng bộ comment tự động qua API.',
      );
      return;
    }

    setSyncing(true);
    try {
      await Promise.all(
        usableTargets.map((target) =>
          commentsApi.sync(workspaceId, {
            socialAccountId: target.socialAccountId,
            platformPostId: target.id,
          }),
        ),
      );
      toast.success(
        `Đã đưa yêu cầu kéo bình luận mới nhất cho ${usableTargets.length} kênh vào hàng đợi. Đang tải lại...`,
      );
      setTimeout(() => {
        void loadComments(true);
        onPostUpdated?.();
      }, 2500);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleInlineReply(commentId: string, message: string) {
    if (!message.trim()) return;
    setBusyKey(`reply-${commentId}`);
    try {
      const targetComment = comments.find((c) => c.id === commentId);
      const finalMessage =
        autoAttachUtm && targetComment
          ? attachUtmToUrlsInText(message.trim(), targetComment.platform)
          : message.trim();
      await commentsApi.reply(workspaceId, commentId, finalMessage);
      toast.success('Đã gửi phản hồi bình luận.');
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleBulkReply() {
    if (selectedCommentIds.size === 0 || !bulkReplyText.trim()) return;
    setBusyKey('bulk-reply');
    try {
      const idsByMessage = new Map<string, string[]>();
      for (const commentId of selectedCommentIds) {
        const targetComment = comments.find((c) => c.id === commentId);
        const msg =
          autoAttachUtm && targetComment
            ? attachUtmToUrlsInText(bulkReplyText.trim(), targetComment.platform)
            : bulkReplyText.trim();
        const group = idsByMessage.get(msg) ?? [];
        group.push(commentId);
        idsByMessage.set(msg, group);
      }

      const groupResponses = await Promise.all(
        Array.from(idsByMessage.entries()).map(([msg, ids]) =>
          commentsApi.bulkReply(workspaceId, ids, msg),
        ),
      );
      const allResults = groupResponses.flatMap((r) => r.results);
      const okCount = allResults.filter((r) => r.queued).length;
      const failCount = allResults.filter((r) => !r.queued).length;
      if (failCount > 0) {
        toast.warning(
          `Đã xếp hàng trả lời ${okCount}/${allResults.length} bình luận (${failCount} lỗi).`,
        );
      } else {
        toast.success(`Đã xếp hàng trả lời ${okCount} bình luận.`);
      }
      setBulkReplyText('');
      setSelectedCommentIds(new Set());
      setTimeout(() => void loadComments(true), 2000);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCreateTopLevelComment() {
    if (!newPostCommentText.trim() || postCommentTargetIds.length === 0) return;
    const rawDraft = newPostCommentText.trim();
    const messageByTargetId = new Map<string, string>();
    const targetIdsByMessage = new Map<string, string[]>();

    for (const targetId of postCommentTargetIds) {
      const target = publishedTargets.find((t) => t.id === targetId);
      if (!target) continue;
      const msg = autoAttachUtm ? attachUtmToUrlsInText(rawDraft, target.platform) : rawDraft;
      messageByTargetId.set(targetId, msg);
      const group = targetIdsByMessage.get(msg) ?? [];
      group.push(targetId);
      targetIdsByMessage.set(msg, group);
    }

    const nowIso = new Date().toISOString();
    const optimisticBatch: OptimisticTopComment[] = [];
    for (const [targetId, msg] of messageByTargetId.entries()) {
      const target = publishedTargets.find((t) => t.id === targetId);
      if (!target) continue;
      optimisticBatch.push({
        id: `opt-${targetId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        platformPostId: targetId,
        platform: target.platform,
        socialAccountName: target.socialAccountName,
        message: msg,
        createdAt: nowIso,
        status: 'SENDING',
      });
    }

    setOptimisticTopComments((prev) => [...optimisticBatch, ...prev]);
    setNewPostCommentText('');
    setBusyKey('create-post-comment');

    try {
      const groupResponses = await Promise.all(
        Array.from(targetIdsByMessage.entries()).map(([msg, ids]) =>
          commentsApi.bulkCreatePlatformComments(workspaceId, ids, msg),
        ),
      );
      const allResults = groupResponses.flatMap((r) => r.results);
      const resultByTargetId = new Map(allResults.map((r) => [r.id, r]));

      setOptimisticTopComments((prev) =>
        prev.map((item) => {
          if (!optimisticBatch.some((b) => b.id === item.id)) return item;
          const res = resultByTargetId.get(item.platformPostId);
          if (!res) return item;
          if (!res.queued) {
            return {
              ...item,
              status: 'FAILED',
              errorMessage: res.errorMessage ?? 'Kênh này không hỗ trợ hoặc từ chối gửi.',
            };
          }
          return {
            ...item,
            jobId: res.jobId,
          };
        }),
      );

      const okCount = allResults.filter((r) => r.queued).length;
      const failCount = allResults.filter((r) => !r.queued).length;
      if (failCount > 0) {
        toast.warning(
          `Đã xếp hàng ${okCount}/${allResults.length} kênh (${failCount} kênh không hỗ trợ hoặc lỗi).`,
        );
      }

      if (!sseConnected && okCount > 0) {
        for (const delayMs of [3000, 10000, 18000]) {
          setTimeout(() => {
            void loadComments(true);
            onPostUpdated?.();
          }, delayMs);
        }
      }
    } catch (err) {
      setOptimisticTopComments((prev) =>
        prev.filter((item) => !optimisticBatch.some((b) => b.id === item.id)),
      );
      setNewPostCommentText(rawDraft);
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleToggleHide(comment: CommentView) {
    setBusyKey(`hide-${comment.id}`);
    try {
      await commentsApi.updateVisibility(workspaceId, comment.id, !comment.isHidden);
      toast.success(comment.isHidden ? 'Đã hiện lại bình luận.' : 'Đã ẩn bình luận trên nền tảng.');
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleEditComment(commentId: string, newMessage: string) {
    if (!newMessage.trim()) return;
    setBusyKey(`edit-${commentId}`);
    try {
      await commentsApi.updateMessage(workspaceId, commentId, {
        message: newMessage.trim(),
        updatePlatform: true,
      });
      toast.success('Đã cập nhật nội dung bình luận.');
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteComment(commentId: string) {
    setBusyKey(`delete-${commentId}`);
    try {
      await commentsApi.delete(workspaceId, commentId, true);
      toast.success('Đã xóa bình luận.');
      await loadComments(true);
      onPostUpdated?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleStatusChange(commentId: string, status: CommentView['status']) {
    setBusyKey(`status-${commentId}`);
    try {
      await commentsApi.updateStatus(workspaceId, commentId, status);
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAssignChange(commentId: string, memberId: string | null) {
    setBusyKey(`assign-${commentId}`);
    try {
      await commentsApi.assign(workspaceId, commentId, memberId);
      toast.success('Đã cập nhật người phụ trách.');
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleToggleTagOnComment(comment: CommentView, tagId: string) {
    setBusyKey(`tag-${comment.id}`);
    try {
      const currentIds = new Set(comment.tags.map((t) => t.id));
      if (currentIds.has(tagId)) {
        currentIds.delete(tagId);
      } else {
        currentIds.add(tagId);
      }
      await commentsApi.updateTags(workspaceId, comment.id, Array.from(currentIds));
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCreateTag(name: string, color: string) {
    if (!name.trim()) return;
    setBusyKey('create-tag');
    try {
      const created = await commentsApi.createTag(workspaceId, { name: name.trim(), color });
      setTags((prev) => [...prev, created]);
      toast.success(`Đã tạo tag "${created.name}".`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAddNote(commentId: string, body: string) {
    if (!body.trim()) return;
    setBusyKey(`note-${commentId}`);
    try {
      await commentsApi.addNote(workspaceId, commentId, body.trim());
      toast.success('Đã lưu ghi chú nội bộ.');
      await loadComments(true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  function formatTemplateBody(rawBody: string): string {
    if (rawBody.includes('{link}')) {
      return rawBody.replaceAll('{link}', defaultProductLinkUrl ?? '');
    }
    const trimmed = rawBody.trimEnd();
    if (trimmed.endsWith('🔗') || trimmed.endsWith(':')) {
      return defaultProductLinkUrl ? `${trimmed} ${defaultProductLinkUrl}` : `${trimmed} `;
    }
    return rawBody;
  }

  function applyTemplateToPostComment(rawBody: string) {
    const formatted = formatTemplateBody(rawBody);
    setNewPostCommentText(formatted);
    window.setTimeout(() => {
      const el = postCommentTextareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(formatted.length, formatted.length);
      }
    }, 0);
  }

  function startEditTemplate(tpl: ReplyTemplateView) {
    setEditingTemplateId(tpl.id);
    setNewTemplateName(tpl.name);
    setNewTemplateBody(tpl.body);
    setShowTemplateManager(true);
  }

  function cancelEditTemplate() {
    setEditingTemplateId(null);
    setNewTemplateName('');
    setNewTemplateBody('');
  }

  async function handleSaveTemplate() {
    if (!newTemplateName.trim() || !newTemplateBody.trim()) return;
    setBusyKey('save-template');
    try {
      if (editingTemplateId) {
        const updated = await commentsApi.updateTemplate(workspaceId, editingTemplateId, {
          name: newTemplateName.trim(),
          body: newTemplateBody.trim(),
        });
        setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        toast.success('Đã cập nhật mẫu câu trả lời.');
      } else {
        const tpl = await commentsApi.createTemplate(workspaceId, {
          storeId: postStoreId ?? null,
          name: newTemplateName.trim(),
          body: newTemplateBody.trim(),
        });
        setTemplates((prev) => [...prev, tpl]);
        toast.success('Đã lưu mẫu câu trả lời mới.');
      }
      setEditingTemplateId(null);
      setNewTemplateName('');
      setNewTemplateBody('');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteTemplate(templateId: string) {
    setBusyKey(`del-tpl-${templateId}`);
    try {
      await commentsApi.deleteTemplate(workspaceId, templateId);
      setTemplates((prev) => prev.filter((t) => t.id !== templateId));
      if (editingTemplateId === templateId) {
        cancelEditTemplate();
      }
      toast.success('Đã xóa mẫu câu trả lời.');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  function toggleCommentSelection(id: string) {
    setSelectedCommentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const primaryExternalUrl =
    (activePlatformPostId !== 'ALL'
      ? publishedTargets.find((t) => t.id === activePlatformPostId)?.externalUrl
      : publishedTargets[0]?.externalUrl) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-[1px]">
      <div aria-label="Đóng ngăn kéo bình luận" className="flex-1" onClick={onClose} />
      <aside className="flex h-full w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-2xl">
        {/* 1. HEADER */}
        <header className="shrink-0 border-b border-slate-200 bg-slate-50/70 px-5 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-700">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Quản lý Bình luận & Phản hồi
                </span>
                {post.store ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                    style={{ backgroundColor: post.store.color ?? '#2563eb' }}
                  >
                    {post.store.name}
                  </span>
                ) : null}
                {primaryExternalUrl ? (
                  <a
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
                    href={primaryExternalUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Mở bài trên MXH <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              <h2 className="mt-1 line-clamp-1 text-base font-bold text-slate-950">
                {post.title || post.body || `Bài viết #${post.id}`}
              </h2>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <SecondaryButton
                className="h-9 px-3 text-xs"
                disabled={syncing || publishedTargets.length === 0}
                onClick={() => void handleSyncCommentsFromPlatform()}
                type="button"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Đang kéo...' : 'Kéo comment mới'}
              </SecondaryButton>
              <button
                aria-label="Đóng"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                onClick={onClose}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Platform Target Tabs */}
          {publishedTargets.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                  activePlatformPostId === 'ALL'
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                }`}
                onClick={() => setActivePlatformPostId('ALL')}
                type="button"
              >
                Tất cả kênh ({publishedTargets.length})
              </button>
              {publishedTargets.map((target) => (
                <button
                  key={target.id}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    activePlatformPostId === target.id
                      ? 'bg-brand-600 text-white'
                      : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                  onClick={() => setActivePlatformPostId(target.id)}
                  type="button"
                >
                  <span>{platformShortLabel(target.platform)}</span>
                  <span className="max-w-32 truncate">{target.socialAccountName}</span>
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {/* 2. FILTER BAR (Status, Tag, Search) */}
        <div className="shrink-0 border-b border-slate-200 bg-white px-5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              <button
                className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                  statusFilter === ''
                    ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                onClick={() => setStatusFilter('')}
                type="button"
              >
                Tất cả ({comments.length})
              </button>
              {STATUSES.map((st) => (
                <button
                  key={st}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                    statusFilter === st
                      ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                  onClick={() => setStatusFilter(st)}
                  type="button"
                >
                  {statusLabel(st)} ({countsByStatus[st] ?? 0})
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <select
                aria-label="Lọc theo Tag"
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-brand-500 focus:outline-none"
                onChange={(e) => setTagFilter(e.target.value)}
                value={tagFilter}
              >
                <option value="">Tất cả Tag</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    Tag: {t.name}
                  </option>
                ))}
              </select>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  className="h-8 w-44 rounded-md border border-slate-200 pl-8 pr-2 text-xs text-slate-900 focus:border-brand-500 focus:outline-none"
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Tìm người / nội dung..."
                  type="text"
                  value={searchQuery}
                />
              </div>
            </div>
          </div>

          {/* Bulk Reply Bar when multiple comments are selected */}
          {selectedCommentIds.size > 0 ? (
            <div className="mt-2.5 rounded-lg border border-brand-200 bg-brand-50/70 p-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-brand-900">
                  Đã chọn {selectedCommentIds.size} bình luận để trả lời hàng loạt
                </span>
                <button
                  className="font-semibold text-slate-500 hover:text-slate-800"
                  onClick={() => setSelectedCommentIds(new Set())}
                  type="button"
                >
                  Bỏ chọn tất cả
                </button>
              </div>
              {sortedTemplates.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {sortedTemplates.map((tpl) => (
                    <button
                      key={tpl.id}
                      className="rounded border border-brand-200 bg-white px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100"
                      onClick={() => setBulkReplyText(formatTemplateBody(tpl.body))}
                      title={tpl.body}
                      type="button"
                    >
                      + {tpl.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex gap-2">
                <textarea
                  className="flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-brand-500 focus:outline-none"
                  onChange={(e) => setBulkReplyText(e.target.value)}
                  placeholder="Nhập nội dung trả lời chung cho các bình luận đã chọn..."
                  rows={2}
                  value={bulkReplyText}
                />
                <PrimaryButton
                  busy={busyKey === 'bulk-reply'}
                  className="self-end h-8 px-3 text-xs"
                  disabled={!canReply || !bulkReplyText.trim() || busyKey !== null}
                  onClick={() => void handleBulkReply()}
                  type="button"
                >
                  Gửi ({selectedCommentIds.size})
                </PrimaryButton>
              </div>
            </div>
          ) : null}
        </div>

        {/* 3. COMMENT TREE LIST */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/40 px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-slate-500">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              Đang tải bình luận...
            </div>
          ) : rootComments.length === 0 && visibleOptimisticComments.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center">
              <MessageSquare className="mx-auto h-8 w-8 text-slate-300" />
              <p className="mt-2 text-sm font-semibold text-slate-800">
                Chưa có bình luận nào trong hệ thống cho bài viết này
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Bấm nút <strong>&ldquo;Kéo comment mới&rdquo;</strong> ở góc trên để tải bình luận
                từ Facebook / Instagram / YouTube về, hoặc viết bình luận chính chủ mới ở khung bên
                dưới.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {visibleOptimisticComments.map((opt) => (
                <div
                  key={opt.id}
                  className={`rounded-lg border p-3 shadow-sm transition ${
                    opt.status === 'FAILED'
                      ? 'border-red-300 bg-red-50/50'
                      : 'border-brand-200 bg-brand-50/30 opacity-90'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-slate-900">
                        {opt.socialAccountName}
                      </span>
                      <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">
                        Chính chủ
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        {platformShortLabel(opt.platform)} · {opt.socialAccountName}
                      </span>
                      {opt.status === 'SENDING' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Đang gửi lên {platformShortLabel(opt.platform)}...
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                          <AlertCircle className="h-3 w-3" />
                          Gửi thất bại
                        </span>
                      )}
                    </div>
                    {opt.status === 'FAILED' ? (
                      <div className="flex items-center gap-2 text-[11px]">
                        <button
                          className="font-semibold text-brand-700 hover:underline"
                          onClick={() => {
                            setNewPostCommentText(opt.message);
                            setOptimisticTopComments((prev) =>
                              prev.filter((item) => item.id !== opt.id),
                            );
                          }}
                          type="button"
                        >
                          Đưa lại vào ô nhập
                        </button>
                        <button
                          className="text-slate-500 hover:text-slate-800"
                          onClick={() =>
                            setOptimisticTopComments((prev) =>
                              prev.filter((item) => item.id !== opt.id),
                            )
                          }
                          type="button"
                        >
                          Ẩn
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-800">
                    {opt.message}
                  </p>
                  {opt.status === 'FAILED' && opt.errorMessage ? (
                    <p className="mt-1.5 text-[11px] font-medium text-red-700">
                      Lý do: {opt.errorMessage}
                    </p>
                  ) : null}
                </div>
              ))}
              {rootComments.map((comment) => (
                <CommentNode
                  key={comment.id}
                  busyKey={busyKey}
                  canAssign={canAssign}
                  canModerate={canModerate}
                  canReply={canReply}
                  childrenByParentId={childrenByParentId}
                  comment={comment}
                  expandedDetailCommentId={expandedDetailCommentId}
                  members={members}
                  onAddNote={handleAddNote}
                  onAssignChange={handleAssignChange}
                  onCreateTag={handleCreateTag}
                  onDeleteComment={handleDeleteComment}
                  onEditComment={handleEditComment}
                  onFormatTemplate={formatTemplateBody}
                  onInlineReply={handleInlineReply}
                  onStatusChange={handleStatusChange}
                  onToggleDetail={(id) =>
                    setExpandedDetailCommentId((prev) => (prev === id ? null : id))
                  }
                  onToggleHide={handleToggleHide}
                  onToggleSelect={toggleCommentSelection}
                  onToggleTag={handleToggleTagOnComment}
                  selectedCommentIds={selectedCommentIds}
                  tags={tags}
                  templates={sortedTemplates}
                />
              ))}
            </div>
          )}
        </div>

        {/* 4. STICKY BOTTOM COMPOSER: NHẮN BÌNH LUẬN CHÍNH CHỦ / GẮN LINK SẢN PHẨM */}
        <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-3.5 shadow-[0_-4px_12px_rgba(15,23,42,0.04)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
              <MessageSquarePlus className="h-4 w-4 text-brand-600" />
              <span>Bình luận chính chủ vào bài viết / Gắn link sản phẩm</span>
            </div>
            <div className="flex items-center gap-3">
              <label
                className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-slate-600 hover:text-slate-900"
                title="Tự động nối thêm ?utm_source=fb/yt/ig&utm_medium=cmt vào link sản phẩm khi gửi để đo lường đơn hàng trên Shopify / GA4"
              >
                <input
                  checked={autoAttachUtm}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  onChange={(e) => toggleAutoAttachUtm(e.target.checked)}
                  type="checkbox"
                />
                <span>Tự gắn UTM theo kênh</span>
              </label>
              <button
                className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
                onClick={() => setShowTemplateManager((prev) => !prev)}
                type="button"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Mẫu câu trả lời ({templates.length})
              </button>
            </div>
          </div>

          {/* Template quick manager / selector */}
          {showTemplateManager ? (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-700">
                  {editingTemplateId ? 'Sửa mẫu câu trả lời' : 'Quản lý mẫu câu trả lời nhanh'}
                </span>
                <button
                  className="text-slate-400 hover:text-slate-700"
                  onClick={() => {
                    cancelEditTemplate();
                    setShowTemplateManager(false);
                  }}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {sortedTemplates.length > 0 ? (
                <div className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                  {sortedTemplates.map((tpl) => {
                    const isMatched = isStoreMatchedTemplate(tpl.name);
                    return (
                      <div
                        key={tpl.id}
                        className={`inline-flex items-center gap-1 rounded border px-2 py-1 ${
                          editingTemplateId === tpl.id
                            ? 'border-brand-500 bg-brand-50'
                            : isMatched
                              ? 'border-brand-200 bg-white'
                              : 'border-slate-200 bg-white'
                        }`}
                      >
                        <button
                          className="font-medium text-brand-700 hover:underline"
                          onClick={() => applyTemplateToPostComment(tpl.body)}
                          title={tpl.body}
                          type="button"
                        >
                          {tpl.name}
                        </button>
                        <button
                          className="ml-1 text-slate-400 hover:text-brand-600"
                          onClick={() => startEditTemplate(tpl)}
                          title="Sửa mẫu"
                          type="button"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          className="text-slate-400 hover:text-red-600"
                          onClick={() => void handleDeleteTemplate(tpl.id)}
                          title="Xóa mẫu"
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 text-slate-500">Chưa có mẫu nào.</p>
              )}
              <div className="mt-2 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    className="w-52 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-none"
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    placeholder="Tên mẫu (VD: PA - Ghim Link SP)"
                    type="text"
                    value={newTemplateName}
                  />
                  <span className="text-[11px] text-slate-500">
                    Mẹo: Để <code className="rounded bg-slate-200 px-1">🔗</code> ở cuối dòng cuối
                    để bấm mẫu xong chỉ cần Ctrl+V dán link.
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <textarea
                    className="flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs leading-relaxed focus:border-brand-500 focus:outline-none"
                    onChange={(e) => setNewTemplateBody(e.target.value)}
                    placeholder={
                      '✈️ Free US Shipping (Worldwide Delivery)\n🏷️ Code: PA10 (10% OFF)\n🔗 '
                    }
                    rows={3}
                    value={newTemplateBody}
                  />
                  <div className="flex flex-col justify-end gap-1">
                    {editingTemplateId ? (
                      <button
                        className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                        onClick={cancelEditTemplate}
                        type="button"
                      >
                        Hủy
                      </button>
                    ) : null}
                    <SecondaryButton
                      className="h-8 px-2.5 text-xs"
                      disabled={
                        !newTemplateName.trim() || !newTemplateBody.trim() || busyKey !== null
                      }
                      onClick={() => void handleSaveTemplate()}
                      type="button"
                    >
                      {editingTemplateId ? 'Cập nhật mẫu' : '+ Lưu mẫu'}
                    </SecondaryButton>
                  </div>
                </div>
              </div>
            </div>
          ) : sortedTemplates.length > 0 ? (
            <div className="mt-1.5 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
              {sortedTemplates.map((tpl) => {
                const isMatched = isStoreMatchedTemplate(tpl.name);
                return (
                  <button
                    key={tpl.id}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                      isMatched
                        ? 'border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700'
                    }`}
                    onClick={() => applyTemplateToPostComment(tpl.body)}
                    title={tpl.body}
                    type="button"
                  >
                    + {tpl.name}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Target selector checkboxes for top-level comment */}
          {publishedTargets.length > 1 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">Gửi lên:</span>
              {publishedTargets.map((target) => {
                const checked = postCommentTargetIds.includes(target.id);
                return (
                  <label
                    key={target.id}
                    className="inline-flex cursor-pointer items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                  >
                    <input
                      checked={checked}
                      onChange={(e) => {
                        setPostCommentTargetIds((prev) =>
                          e.target.checked
                            ? [...prev, target.id]
                            : prev.filter((id) => id !== target.id),
                        );
                      }}
                      type="checkbox"
                    />
                    <span>
                      {platformShortLabel(target.platform)} · {target.socialAccountName}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <textarea
              ref={postCommentTextareaRef}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs leading-relaxed text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              onChange={(e) => setNewPostCommentText(e.target.value)}
              placeholder="Chọn mẫu câu ở trên rồi Ctrl+V dán link sản phẩm, hoặc nhập bình luận chính chủ..."
              rows={3}
              value={newPostCommentText}
            />
            <PrimaryButton
              busy={busyKey === 'create-post-comment'}
              className="self-end px-3.5 py-2 text-xs"
              disabled={
                !canReply ||
                !newPostCommentText.trim() ||
                postCommentTargetIds.length === 0 ||
                busyKey !== null
              }
              onClick={() => void handleCreateTopLevelComment()}
              type="button"
            >
              <Send className="h-3.5 w-3.5" />
              Đăng cmt ({postCommentTargetIds.length})
            </PrimaryButton>
          </div>
          {autoAttachUtm && hasEligibleStoreUrl(newPostCommentText) ? (
            <p className="mt-1.5 text-[11px] text-emerald-700">
              ✓ Khi gửi sẽ tự gắn UTM rút gọn theo từng kênh:{' '}
              {Array.from(
                new Set(
                  publishedTargets
                    .filter((t) => postCommentTargetIds.includes(t.id))
                    .map((t) => t.platform),
                ),
              )
                .map(
                  (platform) =>
                    `${platformShortLabel(platform)} → ?utm_source=${platformUtmSource(platform)}&utm_medium=cmt`,
                )
                .join(' · ')}
            </p>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}

function CommentNode({
  comment,
  depth = 0,
  childrenByParentId,
  selectedCommentIds,
  expandedDetailCommentId,
  busyKey,
  canReply,
  canModerate,
  canAssign,
  tags,
  templates,
  members,
  onToggleSelect,
  onToggleDetail,
  onInlineReply,
  onToggleHide,
  onEditComment,
  onDeleteComment,
  onStatusChange,
  onAssignChange,
  onToggleTag,
  onCreateTag,
  onAddNote,
  onFormatTemplate,
}: {
  comment: CommentView;
  depth?: number;
  childrenByParentId: Map<string, CommentView[]>;
  selectedCommentIds: Set<string>;
  expandedDetailCommentId: string | null;
  busyKey: string | null;
  canReply: boolean;
  canModerate: boolean;
  canAssign: boolean;
  tags: CommentTagView[];
  templates: ReplyTemplateView[];
  members: WorkspaceMember[];
  onToggleSelect: (id: string) => void;
  onToggleDetail: (id: string) => void;
  onInlineReply: (commentId: string, message: string) => Promise<void>;
  onToggleHide: (comment: CommentView) => Promise<void>;
  onEditComment: (commentId: string, newMessage: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
  onStatusChange: (commentId: string, status: CommentView['status']) => Promise<void>;
  onAssignChange: (commentId: string, memberId: string | null) => Promise<void>;
  onToggleTag: (comment: CommentView, tagId: string) => Promise<void>;
  onCreateTag: (name: string, color: string) => Promise<void>;
  onAddNote: (commentId: string, body: string) => Promise<void>;
  onFormatTemplate: (rawBody: string) => string;
}) {
  const children = childrenByParentId.get(comment.id) ?? [];
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(comment.message ?? '');
  const [noteText, setNoteText] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<string>(TAG_COLORS[0]);

  const isDetailOpen = expandedDetailCommentId === comment.id;
  const isReplying = busyKey === `reply-${comment.id}`;

  return (
    <div
      className={`rounded-lg ${
        depth === 0 ? 'border border-slate-200 bg-white p-3 shadow-sm' : 'mt-2 bg-slate-50/70 p-2.5'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <input
          aria-label={`Chọn bình luận của ${comment.authorName ?? 'khách'}`}
          checked={selectedCommentIds.has(comment.id)}
          className="mt-1 h-3.5 w-3.5 rounded border-slate-300"
          onChange={() => onToggleSelect(comment.id)}
          type="checkbox"
        />

        <div className="min-w-0 flex-1">
          {/* Comment Header */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-bold text-slate-900">
              {comment.authorName ?? 'Người dùng ẩn danh'}
            </span>
            {comment.isFromPage ? (
              <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">
                Chính chủ
              </span>
            ) : null}
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
              {platformShortLabel(comment.platform)} · {comment.socialAccountName}
            </span>
            <span className="text-[11px] text-slate-400">{formatDateTime(comment.postedAt)}</span>
            {comment.isHidden ? (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                Đang ẩn
              </span>
            ) : null}
            <CommentStatusBadge status={comment.status} />
          </div>

          {/* Tags & Assignment pills */}
          {comment.tags.length > 0 || comment.assignment ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {comment.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  style={{ backgroundColor: tag.color }}
                >
                  {tag.name}
                </span>
              ))}
              {comment.assignment ? (
                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                  <UserCheck className="h-3 w-3" />
                  {comment.assignment.assignedToName ?? comment.assignment.assignedToEmail}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Message or Edit Box */}
          {editing ? (
            <div className="mt-2 space-y-1.5">
              <textarea
                className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-none"
                onChange={(e) => setEditText(e.target.value)}
                rows={2}
                value={editText}
              />
              <div className="flex justify-end gap-1.5">
                <button
                  className="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                  onClick={() => setEditing(false)}
                  type="button"
                >
                  Hủy
                </button>
                <button
                  className="rounded bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"
                  disabled={!editText.trim() || busyKey === `edit-${comment.id}`}
                  onClick={async () => {
                    await onEditComment(comment.id, editText);
                    setEditing(false);
                  }}
                  type="button"
                >
                  Lưu
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-800">
              {comment.message || 'Không có nội dung văn bản.'}
            </p>
          )}

          {/* Action Links under Comment */}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] font-semibold">
            {canReply ? (
              <button
                className="text-brand-600 hover:underline"
                onClick={() => setReplyOpen((prev) => !prev)}
                type="button"
              >
                Phản hồi
              </button>
            ) : null}

            {canModerate ? (
              <>
                <button
                  className="inline-flex items-center gap-0.5 text-slate-500 hover:text-slate-900"
                  disabled={busyKey === `hide-${comment.id}`}
                  onClick={() => void onToggleHide(comment)}
                  type="button"
                >
                  {comment.isHidden ? (
                    <>
                      <Eye className="h-3 w-3" /> Hiện lại
                    </>
                  ) : (
                    <>
                      <EyeOff className="h-3 w-3" /> Ẩn
                    </>
                  )}
                </button>

                {comment.isFromPage ? (
                  <button
                    className="inline-flex items-center gap-0.5 text-slate-500 hover:text-slate-900"
                    onClick={() => {
                      setEditText(comment.message ?? '');
                      setEditing(true);
                    }}
                    type="button"
                  >
                    <Pencil className="h-3 w-3" /> Sửa
                  </button>
                ) : null}

                <button
                  className="inline-flex items-center gap-0.5 text-slate-500 hover:text-red-600"
                  disabled={busyKey === `delete-${comment.id}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Xóa bình luận này khỏi hệ thống và trên nền tảng mạng xã hội?',
                      )
                    ) {
                      void onDeleteComment(comment.id);
                    }
                  }}
                  type="button"
                >
                  <Trash2 className="h-3 w-3" /> Xóa
                </button>
              </>
            ) : null}

            <button
              className={`inline-flex items-center gap-0.5 ${
                isDetailOpen ? 'text-brand-700 underline' : 'text-slate-500 hover:text-slate-900'
              }`}
              onClick={() => onToggleDetail(comment.id)}
              type="button"
            >
              <Tag className="h-3 w-3" />
              Xử lý / Tag / Ghi chú ({comment.notes.length})
            </button>

            {comment.likeCount ? (
              <span className="ml-auto font-normal text-slate-400">
                {comment.likeCount} lượt thích
              </span>
            ) : null}
          </div>

          {/* Inline Reply Input */}
          {replyOpen ? (
            <div className="mt-2.5 rounded-md border border-slate-200 bg-slate-50 p-2">
              {templates.length > 0 ? (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-brand-700 hover:bg-brand-50"
                      onClick={() => {
                        const formatted = onFormatTemplate(tpl.body);
                        setReplyText(formatted);
                        window.setTimeout(() => {
                          const el = replyTextareaRef.current;
                          if (el) {
                            el.focus();
                            el.setSelectionRange(formatted.length, formatted.length);
                          }
                        }, 0);
                      }}
                      title={tpl.body}
                      type="button"
                    >
                      + {tpl.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={replyTextareaRef}
                autoFocus
                className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-slate-900 focus:border-brand-500 focus:outline-none"
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={`Trả lời ${comment.authorName ?? 'bình luận'}...`}
                rows={3}
                value={replyText}
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button
                  className="rounded px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
                  disabled={isReplying}
                  onClick={() => {
                    setReplyOpen(false);
                    setReplyText('');
                  }}
                  type="button"
                >
                  Hủy
                </button>
                <button
                  className="rounded bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                  disabled={!replyText.trim() || isReplying}
                  onClick={async () => {
                    await onInlineReply(comment.id, replyText);
                    setReplyOpen(false);
                    setReplyText('');
                  }}
                  type="button"
                >
                  {isReplying ? 'Đang gửi...' : 'Gửi phản hồi'}
                </button>
              </div>
            </div>
          ) : null}

          {/* System sent/pending replies history */}
          {comment.replies.length > 0 ? (
            <div className="mt-2 space-y-1 border-l-2 border-brand-200 pl-2.5">
              {comment.replies.map((rep) => (
                <div key={rep.id} className="text-[11px] text-slate-600">
                  <span className="font-semibold text-brand-700">Phản hồi từ hệ thống:</span>{' '}
                  <span>{rep.message}</span>{' '}
                  <span className="text-[10px] text-slate-400">({rep.status})</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* Inline Moderation / Tag / Note Drawer */}
          {isDetailOpen ? (
            <div className="mt-2.5 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">
                    Trạng thái xử lý
                  </label>
                  <select
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    disabled={!canModerate}
                    onChange={(e) =>
                      void onStatusChange(comment.id, e.target.value as CommentView['status'])
                    }
                    value={comment.status}
                  >
                    {STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {statusLabel(st)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">
                    Người phụ trách
                  </label>
                  <select
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    disabled={!canAssign}
                    onChange={(e) => void onAssignChange(comment.id, e.target.value || null)}
                    value={comment.assignment?.memberId ?? ''}
                  >
                    <option value="">Chưa gán</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? m.email}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tags */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Gắn Tag</label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {tags.map((t) => {
                    const active = comment.tags.some((ct) => ct.id === t.id);
                    return (
                      <button
                        key={t.id}
                        className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                          active
                            ? 'text-white ring-2 ring-slate-900/20'
                            : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                        onClick={() => void onToggleTag(comment, t.id)}
                        style={active ? { backgroundColor: t.color } : undefined}
                        type="button"
                      >
                        {active ? '✓ ' : '+ '}
                        {t.name}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    onChange={(e) => setNewTagName(e.target.value)}
                    placeholder="Tạo tag mới..."
                    type="text"
                    value={newTagName}
                  />
                  <input
                    className="h-6 w-8 cursor-pointer rounded border border-slate-300 bg-white p-0.5"
                    onChange={(e) => setNewTagColor(e.target.value)}
                    type="color"
                    value={newTagColor}
                  />
                  <button
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                    disabled={!newTagName.trim()}
                    onClick={async () => {
                      await onCreateTag(newTagName, newTagColor);
                      setNewTagName('');
                    }}
                    type="button"
                  >
                    + Tạo Tag
                  </button>
                </div>
              </div>

              {/* Internal Notes */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">
                  Ghi chú nội bộ ({comment.notes.length})
                </label>
                {comment.notes.length > 0 ? (
                  <div className="mt-1 space-y-1.5">
                    {comment.notes.map((n) => (
                      <div
                        key={n.id}
                        className="rounded border border-slate-200 bg-white px-2.5 py-1.5 text-[11px]"
                      >
                        <div className="font-semibold text-slate-700">
                          {n.authorName ?? n.authorEmail}{' '}
                          <span className="font-normal text-slate-400">
                            · {formatDateTime(n.createdAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-slate-600">{n.body}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Thêm ghi chú nội bộ cho team..."
                    type="text"
                    value={noteText}
                  />
                  <button
                    className="rounded bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
                    disabled={!noteText.trim()}
                    onClick={async () => {
                      await onAddNote(comment.id, noteText);
                      setNoteText('');
                    }}
                    type="button"
                  >
                    Lưu note
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Nested Replies */}
          {children.length > 0 ? (
            <div className="mt-2 border-l-2 border-slate-200 pl-3">
              {children.map((child) => (
                <CommentNode
                  key={child.id}
                  busyKey={busyKey}
                  canAssign={canAssign}
                  canModerate={canModerate}
                  canReply={canReply}
                  childrenByParentId={childrenByParentId}
                  comment={child}
                  depth={depth + 1}
                  expandedDetailCommentId={expandedDetailCommentId}
                  members={members}
                  onAddNote={onAddNote}
                  onAssignChange={onAssignChange}
                  onCreateTag={onCreateTag}
                  onDeleteComment={onDeleteComment}
                  onEditComment={onEditComment}
                  onFormatTemplate={onFormatTemplate}
                  onInlineReply={onInlineReply}
                  onStatusChange={onStatusChange}
                  onToggleDetail={onToggleDetail}
                  onToggleHide={onToggleHide}
                  onToggleSelect={onToggleSelect}
                  onToggleTag={onToggleTag}
                  selectedCommentIds={selectedCommentIds}
                  tags={tags}
                  templates={templates}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CommentStatusBadge({ status }: { status: CommentView['status'] }) {
  const Icon = status === 'RESOLVED' ? CheckCircle2 : status === 'PENDING' ? Clock3 : MessageSquare;
  const tone =
    status === 'RESOLVED'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'PENDING'
        ? 'bg-amber-50 text-amber-700'
        : 'bg-slate-100 text-slate-600';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}
    >
      <Icon className="h-3 w-3" />
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status: string) {
  if (status === 'OPEN') return 'Cần xử lý';
  if (status === 'PENDING') return 'Đang chờ';
  if (status === 'RESOLVED') return 'Đã xong';
  return status;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value));
}
