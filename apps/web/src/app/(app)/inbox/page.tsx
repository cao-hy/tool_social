'use client';

import {
  capabilityBlockReason,
  hasPermission,
  isCapabilityUsable,
  PLATFORM_LABELS,
  type Platform,
} from '@socialhub/shared';
import {
  CheckCircle2,
  Clock3,
  MessageSquare,
  Eye,
  EyeOff,
  Pencil,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  StickyNote,
  Tag,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/form-controls';
import { commentsApi, platformsApi, socialAccountsApi, workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type {
  CommentTagView,
  CommentView,
  PlatformCapabilitiesView,
  ReplyTemplateView,
  SocialAccountView,
  WorkspaceMember,
} from '@/lib/types';

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED'] as const;
const TAG_COLORS = ['#64748b', '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed'] as const;
const DEFAULT_TAG_COLOR = TAG_COLORS[0];

export default function InboxPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [comments, setComments] = useState<CommentView[]>([]);
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [tags, setTags] = useState<CommentTagView[]>([]);
  const [templates, setTemplates] = useState<ReplyTemplateView[]>([]);
  const [capabilityByPlatform, setCapabilityByPlatform] = useState<
    Partial<Record<Platform, PlatformCapabilitiesView>>
  >({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [assignedToId, setAssignedToId] = useState('');
  const [tagId, setTagId] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<string>(DEFAULT_TAG_COLOR);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateBody, setNewTemplateBody] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      status: status || undefined,
      platform: platform || undefined,
      assignedToId: assignedToId || undefined,
      tagId: tagId || undefined,
      q: debouncedQuery.trim() || undefined,
      limit: 100,
    }),
    [assignedToId, debouncedQuery, platform, status, tagId],
  );

  async function loadComments() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const commentResult = await commentsApi.list(workspace.id, filters);
      setComments(commentResult.items);
      keepSelectedComment(commentResult.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadStaticData() {
    if (!workspace) return;
    setError(null);
    try {
      const [accountResult, memberResult, tagResult, templateResult, capabilityResult] =
        await Promise.all([
          socialAccountsApi.list(workspace.id),
          workspaceApi.members(workspace.id),
          commentsApi.listTags(workspace.id),
          commentsApi.listTemplates(workspace.id),
          platformsApi.capabilities(),
        ]);
      setAccounts(accountResult.items);
      setMembers(memberResult.items);
      setTags(tagResult.items);
      setTemplates(templateResult.items);
      setCapabilityByPlatform(
        Object.fromEntries(
          capabilityResult.platforms.map((item) => [item.platform, item]),
        ) as Partial<Record<Platform, PlatformCapabilitiesView>>,
      );
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    }
  }

  function keepSelectedComment(items: CommentView[]) {
    setSelectedId((current) =>
      current && items.some((comment) => comment.id === current) ? current : null,
    );
  }

  function scheduleCommentReloads() {
    for (const delayMs of [1500, 4000, 8000]) {
      window.setTimeout(() => void loadComments(), delayMs);
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 350);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    void loadStaticData();
  }, [workspace]);

  useEffect(() => {
    void loadComments();
  }, [workspace, filters]);

  const rootComments = useMemo(() => comments.filter((comment) => !comment.parentId), [comments]);
  const counts = useMemo(() => statusCounts(comments), [comments]);

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canModerate = hasPermission(workspace.role, 'comment:moderate');
  const canAssign = hasPermission(workspace.role, 'comment:assign');
  const canReply = hasPermission(workspace.role, 'comment:reply');
  const selected = comments.find((comment) => comment.id === selectedId) ?? null;
  const selectedAccount = selected
    ? accounts.find((account) => account.id === selected.socialAccountId)
    : undefined;
  const selectedCapability = selected ? capabilityByPlatform[selected.platform] : undefined;
  const replyCapability = selectedCapability?.capabilities.replyToComment;
  const replyBlockReason =
    selected?.platform === 'FACEBOOK' &&
    selectedAccount &&
    !selectedAccount.scopes.includes('pages_manage_engagement')
      ? 'Facebook token hiện tại thiếu quyền pages_manage_engagement. Hãy ngắt kết nối rồi kết nối lại Facebook Page để cấp quyền reply comment.'
      : selected && !isCapabilityUsable(replyCapability)
        ? capabilityBlockReason(replyCapability)
        : null;

  const syncAccount = platform
    ? accounts.find((account) => account.platform === platform)
    : accounts[0];
  const syncCapability = syncAccount
    ? capabilityByPlatform[syncAccount.platform]?.capabilities.readComments
    : undefined;
  const missingFacebookCommentScope =
    syncAccount?.platform === 'FACEBOOK' && !syncAccount.scopes.includes('pages_read_user_content')
      ? 'Facebook token hiện tại thiếu quyền pages_read_user_content. Hãy ngắt kết nối rồi kết nối lại Facebook Page để cấp thêm quyền đọc comment.'
      : null;
  const syncBlockReason =
    (platform && !syncAccount
      ? `Chưa có tài khoản ${PLATFORM_LABELS[platform as Platform]} đã kết nối.`
      : null) ??
    missingFacebookCommentScope ??
    (syncAccount && !isCapabilityUsable(syncCapability)
      ? capabilityBlockReason(syncCapability)
      : null);
  const syncAccountName = syncAccount?.name ?? 'tài khoản đầu tiên';
  const activeAdvancedFilterCount = [platform, assignedToId, tagId].filter(Boolean).length;
  const hasAnyFilter = Boolean(
    status || platform || assignedToId || tagId || debouncedQuery.trim(),
  );
  const selectedChildComments = selected
    ? comments.filter((comment) => comment.parentId === selected.id)
    : [];
  const selectedPostLabel = selected?.contentPostTitle ?? selected?.contentPostId ?? 'Bài đăng';
  const selectedAssignee =
    selected?.assignment?.assignedToName ?? selected?.assignment?.assignedToEmail ?? 'Chưa gán';
  const emptyState = syncBlockReason
    ? {
        title: 'Chưa thể đồng bộ comment',
        body: syncBlockReason,
      }
    : hasAnyFilter
      ? {
          title: 'Không có comment khớp bộ lọc',
          body: 'Thử bỏ bớt filter, đổi tài khoản, hoặc bấm sync lại sau khi comment mới xuất hiện.',
        }
      : {
          title: 'Chưa có comment trong inbox',
          body: `Bấm sync để kéo comment từ ${syncAccountName}. Hệ thống chỉ kéo comment từ post đã publish trong SocialHub và nền tảng có hỗ trợ đọc comment.`,
        };

  async function mutateComment(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      await loadComments();
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(null);
    }
  }

  async function mutateStatic(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      await Promise.all([loadStaticData(), loadComments()]);
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(null);
    }
  }

  async function syncSelectedAccount() {
    const accountId = syncAccount?.id;
    if (!workspace || !accountId) {
      setError('Cần có ít nhất một social account để sync comments.');
      return;
    }
    const account = accounts.find((item) => item.id === accountId);
    const capability = account
      ? capabilityByPlatform[account.platform]?.capabilities.readComments
      : undefined;
    const reason =
      account?.platform === 'FACEBOOK' && !account.scopes.includes('pages_read_user_content')
        ? 'Facebook token hiện tại thiếu quyền pages_read_user_content. Hãy ngắt kết nối rồi kết nối lại Facebook Page để cấp thêm quyền đọc comment.'
        : account && !isCapabilityUsable(capability)
          ? capabilityBlockReason(capability)
          : null;
    if (reason) {
      setError(reason);
      return;
    }
    await mutateComment('sync', async () => {
      const result = await commentsApi.sync(workspace.id, { socialAccountId: accountId });
      setNotice(`Đang sync comments trong nền: ${result.jobId}`);
      scheduleCommentReloads();
    });
  }

  function clearFilters() {
    setStatus('');
    setPlatform('');
    setAssignedToId('');
    setTagId('');
    setQuery('');
    setDebouncedQuery('');
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Inbox</h1>
          <p className="mt-1 text-sm text-slate-600">
            Quản lý comment từ các nền tảng. Bấm một dòng để xem chi tiết và xử lý.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <IconButton disabled={loading} label="Làm mới" onClick={() => void loadComments()}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
          <PrimaryButton
            disabled={!canModerate || busy !== null || accounts.length === 0 || !!syncBlockReason}
            onClick={() => void syncSelectedAccount()}
            title={syncBlockReason ?? undefined}
            type="button"
          >
            {busy === 'sync' ? 'Đang sync...' : `Sync ${syncAccountName}`}
          </PrimaryButton>
        </div>
      </header>

      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </div>
      ) : null}
      <InlineError message={error} />

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,520px)_auto] xl:items-center">
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
            <StatusTab
              active={status === ''}
              count={comments.length}
              label="Tất cả"
              onClick={() => setStatus('')}
            />
            {STATUSES.map((item) => (
              <StatusTab
                key={item}
                active={status === item}
                count={counts[item] ?? 0}
                label={statusLabel(item)}
                onClick={() => setStatus(item)}
              />
            ))}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <TextInput
              aria-label="Tìm comment"
              className="pl-9"
              placeholder="Tìm người bình luận, nội dung, bài post..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <button
            className={`inline-flex h-11 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition hover:-translate-y-px hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              showAdvancedFilters || activeAdvancedFilterCount > 0
                ? 'border-brand-200 bg-brand-50 text-brand-700'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
            aria-expanded={showAdvancedFilters}
            onClick={() => setShowAdvancedFilters((current) => !current)}
            type="button"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Bộ lọc {activeAdvancedFilterCount > 0 ? `(${activeAdvancedFilterCount})` : ''}
          </button>
        </div>

        {showAdvancedFilters ? (
          <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 md:grid-cols-3">
            <Field label="Nền tảng">
              <SelectInput value={platform} onChange={(event) => setPlatform(event.target.value)}>
                <option value="">Tất cả nền tảng</option>
                {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Người phụ trách">
              <SelectInput
                value={assignedToId}
                onChange={(event) => setAssignedToId(event.target.value)}
              >
                <option value="">Tất cả</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name ?? member.email}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Tag">
              <SelectInput value={tagId} onChange={(event) => setTagId(event.target.value)}>
                <option value="">Tất cả tag</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {loading ? 'Đang tải...' : `Hiển thị ${rootComments.length} comment gốc`}
            </p>
            <p className="text-xs text-slate-500">
              Danh sách tổng quan, thao tác nằm trong chi tiết.
            </p>
          </div>
          {hasAnyFilter ? (
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 transition hover:-translate-y-px hover:bg-slate-50 hover:shadow-sm"
              onClick={clearFilters}
              type="button"
            >
              <X className="h-4 w-4" />
              Xóa lọc
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[1120px] w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                <th className="border-b border-slate-200 px-4 py-3">Nền tảng</th>
                <th className="border-b border-slate-200 px-4 py-3">Comment</th>
                <th className="border-b border-slate-200 px-4 py-3">Bài đăng</th>
                <th className="border-b border-slate-200 px-4 py-3">Trạng thái</th>
                <th className="border-b border-slate-200 px-4 py-3">Phụ trách</th>
                <th className="border-b border-slate-200 px-4 py-3">Tag</th>
                <th className="border-b border-slate-200 px-4 py-3">Thời gian</th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {rootComments.map((comment) => (
                <tr
                  key={comment.id}
                  className={`group cursor-pointer transition hover:bg-slate-50 ${
                    selectedId === comment.id ? 'bg-brand-50' : 'bg-white'
                  }`}
                  onClick={() => setSelectedId(comment.id)}
                >
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <div className="flex min-w-[150px] flex-col gap-1">
                      <span className="w-fit rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                        {platformShortLabel(comment.platform)}
                      </span>
                      <span className="truncate text-xs text-slate-500">
                        {comment.socialAccountName}
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <div className="max-w-[360px]">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-slate-950">
                          {comment.authorName ?? 'Unknown author'}
                        </p>
                        {comment.isFromPage ? (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">
                            Page
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-slate-600">
                        {comment.message ?? 'Không có nội dung.'}
                      </p>
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <a
                      className="block max-w-[180px] truncate text-sm font-medium text-brand-700 hover:text-brand-800"
                      href={`/posts/${comment.contentPostId}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {comment.contentPostTitle ?? comment.contentPostId}
                    </a>
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <StatusBadge status={comment.status} />
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <p className="max-w-[140px] truncate text-sm text-slate-700">
                      {comment.assignment?.assignedToName ??
                        comment.assignment?.assignedToEmail ??
                        'Chưa gán'}
                    </p>
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <div className="flex max-w-[180px] flex-wrap gap-1">
                      {comment.tags.length > 0 ? (
                        comment.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag.id}
                            className="rounded px-1.5 py-0.5 text-xs font-medium text-white"
                            style={{ backgroundColor: tag.color }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm text-slate-400">-</span>
                      )}
                      {comment.tags.length > 2 ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          +{comment.tags.length - 2}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 align-top">
                    <p className="whitespace-nowrap text-sm text-slate-600">
                      {formatDateTime(comment.postedAt)}
                    </p>
                    {comment.likeCount ? (
                      <p className="mt-1 text-xs text-slate-500">{comment.likeCount} likes</p>
                    ) : null}
                  </td>
                  <td className="border-b border-slate-100 px-4 py-3 text-right align-top">
                    <button
                      className="rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedId(comment.id);
                      }}
                      type="button"
                    >
                      Xem
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && rootComments.length === 0 ? (
          <div className="p-8">
            <p className="text-sm font-semibold text-slate-950">{emptyState.title}</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">{emptyState.body}</p>
          </div>
        ) : null}
      </section>

      {selected ? (
        <CommentDrawer
          busy={busy}
          canAssign={canAssign}
          canModerate={canModerate}
          canReply={canReply}
          comment={selected}
          members={members}
          noteBody={noteBody}
          onAssign={(memberId) =>
            void mutateComment('assign', () =>
              commentsApi.assign(workspace.id, selected.id, memberId || null),
            )
          }
          onClose={() => setSelectedId(null)}
          onCreateTag={() =>
            void mutateStatic('create-tag', async () => {
              await commentsApi.createTag(workspace.id, {
                name: newTagName.trim(),
                color: newTagColor,
              });
              setNewTagName('');
            })
          }
          onCreateTemplate={() =>
            void mutateStatic('template', async () => {
              await commentsApi.createTemplate(workspace.id, {
                name: newTemplateName,
                body: newTemplateBody,
              });
              setNewTemplateName('');
              setNewTemplateBody('');
            })
          }
          onDeleteTemplate={(templateId) =>
            void mutateStatic('delete-template', () =>
              commentsApi.deleteTemplate(workspace.id, templateId),
            )
          }
          onDeleteComment={(commentId, deleteFromPlatform) =>
            void mutateComment('delete-comment', async () => {
              await commentsApi.delete(workspace.id, commentId, deleteFromPlatform);
              if (commentId === selected.id) setSelectedId(null);
            })
          }
          onEditComment={(commentId, message) =>
            void mutateComment('edit-comment', () =>
              commentsApi.updateMessage(workspace.id, commentId, {
                message,
                updatePlatform: true,
              }),
            )
          }
          onToggleHidden={(commentId, hidden) =>
            void mutateComment('hide-comment', () =>
              commentsApi.updateVisibility(workspace.id, commentId, hidden),
            )
          }
          onAddNote={() =>
            void mutateComment('note', async () => {
              await commentsApi.addNote(workspace.id, selected.id, noteBody);
              setNoteBody('');
            })
          }
          onNoteBodyChange={setNoteBody}
          onRemoveTag={(removeTagId) =>
            void mutateComment('tags', () =>
              commentsApi.updateTags(
                workspace.id,
                selected.id,
                selected.tags.filter((item) => item.id !== removeTagId).map((item) => item.id),
              ),
            )
          }
          onReply={() =>
            void mutateComment('reply', async () => {
              await commentsApi.reply(workspace.id, selected.id, replyBody);
              setReplyBody('');
            })
          }
          onReplyBodyChange={setReplyBody}
          onSelectTag={(nextTagId) => {
            const tagIds = new Set(selected.tags.map((tag) => tag.id));
            tagIds.add(nextTagId);
            void mutateComment('tags', () =>
              commentsApi.updateTags(workspace.id, selected.id, [...tagIds]),
            );
          }}
          onStatusChange={(nextStatus) =>
            void mutateComment('status', () =>
              commentsApi.updateStatus(workspace.id, selected.id, nextStatus),
            )
          }
          onTemplateBodyChange={setNewTemplateBody}
          onTemplateNameChange={setNewTemplateName}
          onUseTemplate={(body) => setReplyBody(body)}
          onTagColorChange={setNewTagColor}
          onTagNameChange={setNewTagName}
          replyBlockReason={replyBlockReason}
          replyBody={replyBody}
          selectedAssignee={selectedAssignee}
          selectedChildComments={selectedChildComments}
          selectedPostLabel={selectedPostLabel}
          tagColor={newTagColor}
          tagName={newTagName}
          tags={tags}
          templateBody={newTemplateBody}
          templateName={newTemplateName}
          templates={templates}
        />
      ) : null}
    </div>
  );
}

function CommentDrawer({
  busy,
  canAssign,
  canModerate,
  canReply,
  comment,
  members,
  noteBody,
  onAssign,
  onClose,
  onCreateTag,
  onCreateTemplate,
  onDeleteTemplate,
  onDeleteComment,
  onEditComment,
  onToggleHidden,
  onAddNote,
  onNoteBodyChange,
  onRemoveTag,
  onReply,
  onReplyBodyChange,
  onSelectTag,
  onStatusChange,
  onTagColorChange,
  onTagNameChange,
  onTemplateBodyChange,
  onTemplateNameChange,
  onUseTemplate,
  replyBlockReason,
  replyBody,
  selectedAssignee,
  selectedChildComments,
  selectedPostLabel,
  tagColor,
  tagName,
  tags,
  templateBody,
  templateName,
  templates,
}: {
  busy: string | null;
  canAssign: boolean;
  canModerate: boolean;
  canReply: boolean;
  comment: CommentView;
  members: WorkspaceMember[];
  noteBody: string;
  onAssign: (memberId: string) => void;
  onClose: () => void;
  onCreateTag: () => void;
  onCreateTemplate: () => void;
  onDeleteTemplate: (templateId: string) => void;
  onDeleteComment: (commentId: string, deleteFromPlatform: boolean) => void;
  onEditComment: (commentId: string, message: string) => void;
  onToggleHidden: (commentId: string, hidden: boolean) => void;
  onAddNote: () => void;
  onNoteBodyChange: (value: string) => void;
  onRemoveTag: (tagId: string) => void;
  onReply: () => void;
  onReplyBodyChange: (value: string) => void;
  onSelectTag: (tagId: string) => void;
  onStatusChange: (status: CommentView['status']) => void;
  onTagColorChange: (value: string) => void;
  onTagNameChange: (value: string) => void;
  onTemplateBodyChange: (value: string) => void;
  onTemplateNameChange: (value: string) => void;
  onUseTemplate: (body: string) => void;
  replyBlockReason: string | null;
  replyBody: string;
  selectedAssignee: string;
  selectedChildComments: CommentView[];
  selectedPostLabel: string;
  tagColor: string;
  tagName: string;
  tags: CommentTagView[];
  templateBody: string;
  templateName: string;
  templates: ReplyTemplateView[];
}) {
  const visibleInternalReplies = comment.replies.filter(
    (reply) => !isReplyAlreadySynced(reply, selectedChildComments),
  );

  return (
    <div className="fixed inset-0 z-40">
      <button
        aria-label="Đóng chi tiết"
        className="absolute inset-0 bg-slate-950/20"
        onClick={onClose}
        type="button"
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-slate-200 bg-white shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={comment.status} />
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                {platformShortLabel(comment.platform)}
              </span>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                {comment.socialAccountName}
              </span>
              {comment.isHidden ? (
                <span className="rounded bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                  Đang ẩn
                </span>
              ) : null}
            </div>
            <h2 className="mt-3 truncate text-lg font-semibold text-slate-950">
              {comment.authorName ?? 'Unknown author'}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{formatDateTime(comment.postedAt)}</p>
          </div>
          <IconButton label="Đóng" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_300px]">
            <main className="space-y-5 p-5">
              <section className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase text-slate-500">Bài đăng</p>
                <a
                  className="mt-1 block truncate text-sm font-semibold text-brand-700 hover:text-brand-800"
                  href={`/posts/${comment.contentPostId}`}
                >
                  {selectedPostLabel}
                </a>
              </section>

              <section>
                <SectionTitle icon={<MessageSquare className="h-4 w-4" />} title="Conversation" />
                <div className="mt-3 space-y-3">
                  <CommentBubble
                    busy={busy}
                    canModerate={canModerate}
                    comment={comment}
                    highlight
                    onDeleteComment={onDeleteComment}
                    onEditComment={onEditComment}
                    onToggleHidden={onToggleHidden}
                  />
                  {selectedChildComments.map((child) => (
                    <CommentBubble
                      key={child.id}
                      busy={busy}
                      canModerate={canModerate}
                      comment={child}
                      onDeleteComment={onDeleteComment}
                      onEditComment={onEditComment}
                      onToggleHidden={onToggleHidden}
                    />
                  ))}
                  {visibleInternalReplies.map((reply) => (
                    <div
                      key={reply.id}
                      className="ml-8 rounded-md border border-brand-100 bg-brand-50 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-brand-700">
                          {reply.sentByName ?? reply.sentByEmail}
                        </p>
                        <span className="rounded bg-white px-2 py-0.5 text-xs font-semibold text-brand-700">
                          {reply.status}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                        {reply.message}
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        {formatDateTime(reply.sentAt ?? reply.createdAt)}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-md border border-slate-200 p-4">
                <SectionTitle icon={<Send className="h-4 w-4" />} title="Reply" />
                {canReply && !replyBlockReason ? (
                  <div className="mt-3 grid gap-2">
                    <SelectInput
                      disabled={templates.length === 0}
                      value=""
                      onChange={(event) => {
                        const template = templates.find((item) => item.id === event.target.value);
                        if (template) onUseTemplate(template.body);
                      }}
                    >
                      <option value="">Chọn quick reply</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </SelectInput>
                    <textarea
                      className="min-h-32 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      placeholder="Nhập câu trả lời..."
                      value={replyBody}
                      onChange={(event) => onReplyBodyChange(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <SecondaryButton
                        disabled={!replyBody}
                        onClick={() => onReplyBodyChange('')}
                        type="button"
                      >
                        Xóa
                      </SecondaryButton>
                      <PrimaryButton
                        disabled={!replyBody.trim() || busy !== null}
                        onClick={onReply}
                        type="button"
                      >
                        Gửi reply
                      </PrimaryButton>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {replyBlockReason ?? 'Vai trò hiện tại không có quyền reply comment.'}
                  </p>
                )}
              </section>

              <section>
                <SectionTitle icon={<StickyNote className="h-4 w-4" />} title="Internal notes" />
                <div className="mt-3 grid gap-2">
                  <textarea
                    className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    placeholder="Ghi chú nội bộ..."
                    value={noteBody}
                    onChange={(event) => onNoteBodyChange(event.target.value)}
                  />
                  <SecondaryButton
                    disabled={!noteBody.trim() || busy !== null}
                    onClick={onAddNote}
                    type="button"
                  >
                    Thêm note
                  </SecondaryButton>
                </div>
                <div className="mt-3 space-y-2">
                  {comment.notes.map((note) => (
                    <div
                      key={note.id}
                      className="rounded-md border border-slate-200 bg-slate-50 p-3"
                    >
                      <p className="whitespace-pre-wrap text-sm text-slate-700">{note.body}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        {note.authorName ?? note.authorEmail} · {formatDateTime(note.createdAt)}
                      </p>
                    </div>
                  ))}
                  {comment.notes.length === 0 ? (
                    <p className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500">
                      Chưa có note nội bộ.
                    </p>
                  ) : null}
                </div>
              </section>
            </main>

            <aside className="space-y-5 border-t border-slate-200 p-5 xl:border-l xl:border-t-0">
              <section>
                <SectionTitle icon={<UserRound className="h-4 w-4" />} title="Workflow" />
                <div className="mt-3 space-y-3">
                  <Field label="Status">
                    <SelectInput
                      disabled={!canModerate || busy !== null}
                      value={comment.status}
                      onChange={(event) =>
                        onStatusChange(event.target.value as CommentView['status'])
                      }
                    >
                      {STATUSES.map((item) => (
                        <option key={item} value={item}>
                          {statusLabel(item)}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="Assignee">
                    <SelectInput
                      disabled={!canAssign || busy !== null}
                      value={comment.assignment?.memberId ?? ''}
                      onChange={(event) => onAssign(event.target.value)}
                    >
                      <option value="">Chưa gán</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name ?? member.email}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    Phụ trách hiện tại: <span className="font-semibold">{selectedAssignee}</span>
                  </p>
                </div>
              </section>

              <section>
                <SectionTitle icon={<Tag className="h-4 w-4" />} title="Tags" />
                <div className="mt-3 space-y-3">
                  <SelectInput
                    disabled={!canModerate || busy !== null}
                    value=""
                    onChange={(event) => {
                      if (event.target.value) onSelectTag(event.target.value);
                    }}
                  >
                    <option value="">Thêm tag</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </SelectInput>
                  <div className="flex flex-wrap gap-2">
                    {comment.tags.map((tagItem) => (
                      <button
                        key={tagItem.id}
                        className="rounded px-2 py-1 text-xs font-medium text-white"
                        disabled={!canModerate || busy !== null}
                        onClick={() => onRemoveTag(tagItem.id)}
                        style={{ backgroundColor: tagItem.color }}
                        type="button"
                      >
                        {tagItem.name} ×
                      </button>
                    ))}
                    {comment.tags.length === 0 ? (
                      <span className="text-sm text-slate-500">Chưa có tag.</span>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="rounded-md border border-slate-200 p-3">
                <h3 className="text-sm font-semibold text-slate-950">Tạo tag</h3>
                <div className="mt-3 grid gap-3">
                  <TextInput
                    placeholder="Tên tag"
                    value={tagName}
                    onChange={(event) => onTagNameChange(event.target.value)}
                  />
                  <SelectInput
                    value={tagColor}
                    onChange={(event) => onTagColorChange(event.target.value)}
                  >
                    {TAG_COLORS.map((color) => (
                      <option key={color} value={color}>
                        {color}
                      </option>
                    ))}
                  </SelectInput>
                  <SecondaryButton
                    disabled={!canModerate || !tagName.trim() || busy !== null}
                    onClick={onCreateTag}
                    type="button"
                  >
                    Tạo tag
                  </SecondaryButton>
                </div>
              </section>

              <section className="rounded-md border border-slate-200 p-3">
                <h3 className="text-sm font-semibold text-slate-950">Quick replies</h3>
                <div className="mt-3 grid gap-2">
                  <TextInput
                    placeholder="Tên mẫu"
                    value={templateName}
                    onChange={(event) => onTemplateNameChange(event.target.value)}
                  />
                  <textarea
                    className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    placeholder="Nội dung mẫu"
                    value={templateBody}
                    onChange={(event) => onTemplateBodyChange(event.target.value)}
                  />
                  <SecondaryButton
                    disabled={
                      !canReply || !templateName.trim() || !templateBody.trim() || busy !== null
                    }
                    onClick={onCreateTemplate}
                    type="button"
                  >
                    Lưu mẫu
                  </SecondaryButton>
                </div>
                {templates.length > 0 ? (
                  <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200">
                    {templates.map((template) => (
                      <div key={template.id} className="px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <button
                            className="min-w-0 flex-1 text-left"
                            onClick={() => onUseTemplate(template.body)}
                            type="button"
                          >
                            <p className="truncate text-sm font-medium text-slate-900">
                              {template.name}
                            </p>
                            <p className="line-clamp-2 text-xs text-slate-500">{template.body}</p>
                          </button>
                          <button
                            className="text-xs font-semibold text-slate-500 hover:text-red-600"
                            disabled={!canReply || busy !== null}
                            onClick={() => onDeleteTemplate(template.id)}
                            type="button"
                          >
                            Xóa
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </aside>
          </div>
        </div>
      </aside>
    </div>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
      <span className="text-slate-500">{icon}</span>
      {title}
    </h3>
  );
}

function StatusBadge({ status }: { status: string }) {
  const Icon = status === 'RESOLVED' ? CheckCircle2 : status === 'PENDING' ? Clock3 : MessageSquare;
  const tone =
    status === 'RESOLVED'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'PENDING'
        ? 'bg-amber-50 text-amber-700'
        : 'bg-slate-100 text-slate-600';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {statusLabel(status)}
    </span>
  );
}

function StatusTab({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-between gap-3 rounded-md border px-3 text-sm font-semibold transition hover:-translate-y-px hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        active
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      }`}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-white text-brand-700' : 'bg-slate-100 text-slate-500'}`}
      >
        {count}
      </span>
    </button>
  );
}

function CommentBubble({
  busy,
  canModerate = false,
  comment,
  highlight = false,
  onDeleteComment,
  onEditComment,
  onToggleHidden,
}: {
  busy?: string | null;
  canModerate?: boolean;
  comment: CommentView;
  highlight?: boolean;
  onDeleteComment?: (commentId: string, deleteFromPlatform: boolean) => void;
  onEditComment?: (commentId: string, message: string) => void;
  onToggleHidden?: (commentId: string, hidden: boolean) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editMessage, setEditMessage] = useState(comment.message ?? '');
  const canEdit = canModerate && comment.platform === 'YOUTUBE' && comment.isFromPage;
  const canHide =
    canModerate &&
    (comment.platform === 'FACEBOOK' ||
      comment.platform === 'INSTAGRAM' ||
      comment.platform === 'YOUTUBE');
  const canDelete =
    canModerate &&
    (comment.platform === 'FACEBOOK' ||
      comment.platform === 'INSTAGRAM' ||
      comment.platform === 'YOUTUBE');
  const hasActions = Boolean(onDeleteComment || onEditComment || onToggleHidden);

  useEffect(() => {
    setEditing(false);
    setConfirmingDelete(false);
    setEditMessage(comment.message ?? '');
  }, [comment.id, comment.message]);

  return (
    <div
      className={`rounded-md border p-3 ${
        highlight ? 'border-slate-300 bg-white' : 'ml-8 border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-950">
            {comment.authorName ?? 'Unknown author'}
          </p>
          <p className="mt-1 text-xs text-slate-500">{formatDateTime(comment.postedAt)}</p>
        </div>
        {hasActions ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {canEdit && onEditComment ? (
              <IconMiniButton label="Sửa" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </IconMiniButton>
            ) : null}
            {canHide && onToggleHidden ? (
              <IconMiniButton
                label={comment.isHidden ? 'Hiện lại' : 'Ẩn'}
                onClick={() => onToggleHidden(comment.id, !comment.isHidden)}
              >
                {comment.isHidden ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
              </IconMiniButton>
            ) : null}
            {canDelete && onDeleteComment ? (
              <IconMiniButton danger label="Xóa" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconMiniButton>
            ) : null}
          </div>
        ) : null}
      </div>

      {editing && onEditComment ? (
        <div className="mt-3 rounded-md border border-brand-200 bg-brand-50 p-2">
          <textarea
            className="min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            value={editMessage}
            onChange={(event) => setEditMessage(event.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <SecondaryButton
              disabled={busy !== null}
              onClick={() => {
                setEditing(false);
                setEditMessage(comment.message ?? '');
              }}
              type="button"
            >
              Hủy
            </SecondaryButton>
            <PrimaryButton
              disabled={!editMessage.trim() || busy !== null}
              onClick={() => {
                onEditComment(comment.id, editMessage);
                setEditing(false);
              }}
              type="button"
            >
              Lưu
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
          {comment.message ?? 'Không có nội dung.'}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {comment.isFromPage ? (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            Comment của page
          </span>
        ) : null}
        {comment.likeCount ? (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {comment.likeCount} likes
          </span>
        ) : null}
        {comment.isHidden ? (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">Đang ẩn</span>
        ) : null}
      </div>
      {confirmingDelete && onDeleteComment ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">Xóa reply/comment này?</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <SecondaryButton
              disabled={busy !== null}
              onClick={() => setConfirmingDelete(false)}
              type="button"
            >
              Hủy
            </SecondaryButton>
            <SecondaryButton
              disabled={busy !== null}
              onClick={() => onDeleteComment(comment.id, false)}
              type="button"
            >
              Chỉ SocialHub
            </SecondaryButton>
            <button
              className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-3 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={busy !== null}
              onClick={() => onDeleteComment(comment.id, true)}
              type="button"
            >
              Xóa cả nền tảng
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IconMiniButton({
  children,
  danger = false,
  label,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition hover:-translate-y-px hover:shadow-sm ${
        danger
          ? 'border-red-200 bg-white text-red-700 hover:bg-red-50'
          : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700'
      }`}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function isReplyAlreadySynced(
  reply: CommentView['replies'][number],
  childComments: CommentView[],
): boolean {
  if (
    reply.externalReplyId &&
    childComments.some((comment) => comment.externalCommentId === reply.externalReplyId)
  ) {
    return true;
  }

  return childComments.some(
    (comment) =>
      comment.isFromPage && normalizeText(comment.message) === normalizeText(reply.message),
  );
}

function normalizeText(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function statusLabel(status: string) {
  if (status === 'OPEN') return 'Cần xử lý';
  if (status === 'PENDING') return 'Đang chờ';
  if (status === 'RESOLVED') return 'Đã xong';
  return status;
}

function platformShortLabel(platform: Platform) {
  if (platform === 'FACEBOOK') return 'FB';
  if (platform === 'INSTAGRAM') return 'IG';
  if (platform === 'YOUTUBE') return 'YT';
  if (platform === 'TIKTOK') return 'TT';
  if (platform === 'PINTEREST') return 'PIN';
  return PLATFORM_LABELS[platform];
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value));
}

function statusCounts(comments: CommentView[]): Record<string, number> {
  return comments.reduce<Record<string, number>>((acc, comment) => {
    acc[comment.status] = (acc[comment.status] ?? 0) + 1;
    return acc;
  }, {});
}
