'use client';

import {
  capabilityBlockReason,
  hasPermission,
  isCapabilityUsable,
  PLATFORM_LABELS,
  type Platform,
} from '@socialhub/shared';
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
  const [socialAccountId, setSocialAccountId] = useState('');
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
      socialAccountId: socialAccountId || undefined,
      assignedToId: assignedToId || undefined,
      tagId: tagId || undefined,
      q: debouncedQuery.trim() || undefined,
      limit: 100,
    }),
    [assignedToId, debouncedQuery, platform, socialAccountId, status, tagId],
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
      current && items.some((comment) => comment.id === current) ? current : (items[0]?.id ?? null),
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

  const commentRows = useMemo(() => buildCommentRows(comments), [comments]);

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const selected = comments.find((comment) => comment.id === selectedId) ?? null;
  const selectedAccount = selected
    ? accounts.find((account) => account.id === selected.socialAccountId)
    : undefined;
  const canModerate = hasPermission(workspace.role, 'comment:moderate');
  const canAssign = hasPermission(workspace.role, 'comment:assign');
  const canReply = hasPermission(workspace.role, 'comment:reply');
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
  const syncAccount = socialAccountId
    ? accounts.find((account) => account.id === socialAccountId)
    : accounts[0];
  const syncCapability = syncAccount
    ? capabilityByPlatform[syncAccount.platform]?.capabilities.readComments
    : undefined;
  const missingFacebookCommentScope =
    syncAccount?.platform === 'FACEBOOK' && !syncAccount.scopes.includes('pages_read_user_content')
      ? 'Facebook token hiện tại thiếu quyền pages_read_user_content. Hãy ngắt kết nối rồi kết nối lại Facebook Page để cấp thêm quyền đọc comment.'
      : null;
  const syncBlockReason =
    missingFacebookCommentScope ??
    (syncAccount && !isCapabilityUsable(syncCapability)
      ? capabilityBlockReason(syncCapability)
      : null);

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
    const accountId = socialAccountId || accounts[0]?.id;
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

  const activeAdvancedFilterCount = [platform, socialAccountId, assignedToId, tagId].filter(
    Boolean,
  ).length;
  const hasAnyFilter = Boolean(
    status || platform || socialAccountId || assignedToId || tagId || debouncedQuery.trim(),
  );
  const selectedChildComments = selected
    ? comments.filter((comment) => comment.parentId === selected.id)
    : [];
  const selectedPostLabel = selected?.contentPostTitle ?? selected?.contentPostId ?? 'Bài đăng';
  const selectedAssignee =
    selected?.assignment?.assignedToName ?? selected?.assignment?.assignedToEmail ?? 'Chưa gán';
  const syncAccountName = syncAccount?.name ?? 'tài khoản đầu tiên';
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

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-brand-700">Phase 7</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Inbox</h1>
          <p className="mt-1 text-sm text-slate-600">
            Màn xử lý comment theo hàng đợi: chọn comment, xem ngữ cảnh bài đăng, trả lời bằng mẫu
            nhanh, gán người phụ trách và ghi note nội bộ.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={loading} onClick={() => void loadComments()} type="button">
            Làm mới
          </SecondaryButton>
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

      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid gap-3 xl:grid-cols-[1fr_auto] xl:items-center">
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
                count={comments.filter((comment) => comment.status === item).length}
                label={statusLabel(item)}
                onClick={() => setStatus(item)}
              />
            ))}
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(220px,360px)_auto]">
            <TextInput
              aria-label="Tìm comment"
              placeholder="Tìm người bình luận, nội dung, bài post..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <SecondaryButton
              aria-expanded={showAdvancedFilters}
              onClick={() => setShowAdvancedFilters((current) => !current)}
              type="button"
            >
              Bộ lọc {activeAdvancedFilterCount > 0 ? `(${activeAdvancedFilterCount})` : ''}
            </SecondaryButton>
          </div>
        </div>

        {showAdvancedFilters ? (
          <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Nền tảng">
              <SelectInput
                value={platform}
                onChange={(event) => {
                  setPlatform(event.target.value);
                  setSocialAccountId('');
                }}
              >
                <option value="">Tất cả nền tảng</option>
                {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Tài khoản">
              <SelectInput
                value={socialAccountId}
                onChange={(event) => setSocialAccountId(event.target.value)}
              >
                <option value="">Tất cả tài khoản</option>
                {accounts
                  .filter((account) => !platform || account.platform === platform)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
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

      <section className="grid gap-4 xl:grid-cols-[430px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-950">
                {loading ? 'Đang tải...' : `${comments.length} comment`}
              </p>
              <p className="text-xs text-slate-500">Chọn một dòng để xử lý ở panel bên phải.</p>
            </div>
            {hasAnyFilter ? (
              <button
                className="text-sm font-medium text-brand-700 hover:text-brand-800"
                onClick={() => {
                  setStatus('');
                  setPlatform('');
                  setSocialAccountId('');
                  setAssignedToId('');
                  setTagId('');
                  setQuery('');
                  setDebouncedQuery('');
                }}
                type="button"
              >
                Xóa lọc
              </button>
            ) : null}
          </div>
          <div className="max-h-[720px] divide-y divide-slate-200 overflow-y-auto">
            {commentRows.map(({ comment, depth }) => (
              <button
                key={comment.id}
                className={`block w-full border-l-4 px-4 py-3 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  selectedId === comment.id
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-transparent bg-white'
                }`}
                onClick={() => setSelectedId(comment.id)}
                style={{ paddingLeft: `${16 + depth * 18}px` }}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-semibold text-slate-950">
                    {comment.authorName ?? 'Unknown author'}
                  </p>
                  <StatusBadge status={comment.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-600">
                  {comment.message ?? 'Không có nội dung.'}
                </p>
                <p className="mt-2 truncate text-xs text-slate-500">
                  Bài: {comment.contentPostTitle ?? comment.contentPostId}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {PLATFORM_LABELS[comment.platform]}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {comment.socialAccountName}
                  </span>
                  {comment.assignment ? (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
                      {comment.assignment.assignedToName ?? comment.assignment.assignedToEmail}
                    </span>
                  ) : null}
                  {comment.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                      style={{ backgroundColor: tag.color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              </button>
            ))}
            {!loading && comments.length === 0 ? (
              <div className="p-6">
                <p className="text-sm font-semibold text-slate-950">{emptyState.title}</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">{emptyState.body}</p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          {selected ? (
            <div>
              <div className="border-b border-slate-200 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={selected.status} />
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                        {PLATFORM_LABELS[selected.platform]}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                        {selected.socialAccountName}
                      </span>
                      {selected.isFromPage ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                          Comment của page
                        </span>
                      ) : null}
                    </div>
                    <h2 className="mt-3 text-lg font-semibold text-slate-950">
                      {selected.authorName ?? 'Unknown author'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      {formatDateTime(selected.postedAt)}
                    </p>
                  </div>
                  <div className="text-left text-sm text-slate-600 xl:text-right">
                    <p className="font-medium text-slate-950">Phụ trách</p>
                    <p>{selectedAssignee}</p>
                  </div>
                </div>

                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Ngữ cảnh bài đăng
                  </p>
                  <a
                    className="mt-1 block truncate text-sm font-semibold text-brand-700 hover:text-brand-800"
                    href={`/posts/${selected.contentPostId}`}
                  >
                    {selectedPostLabel}
                  </a>
                  <p className="mt-1 text-xs text-slate-500">
                    Inbox chỉ sync comment từ post đã publish trong SocialHub và nền tảng có quyền
                    đọc comment.
                  </p>
                </div>
              </div>

              <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_300px]">
                <main className="space-y-5 p-5">
                  <section>
                    <h3 className="text-sm font-semibold text-slate-950">Conversation</h3>
                    <div className="mt-3 space-y-3">
                      <CommentBubble comment={selected} highlight />
                      {selectedChildComments.map((comment) => (
                        <CommentBubble key={comment.id} comment={comment} />
                      ))}
                      {selected.replies.map((reply) => (
                        <div
                          key={reply.id}
                          className="ml-8 rounded-md border border-brand-100 bg-brand-50 p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold text-brand-700">
                              {reply.sentByName ?? reply.sentByEmail}
                            </p>
                            <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-brand-700">
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

                  <section className="rounded-lg border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-950">Reply</h3>
                        <p className="mt-1 text-xs text-slate-500">
                          Quick replies là mẫu câu trả lời sẵn. Chọn mẫu để đổ vào ô reply, sửa lại
                          nếu cần rồi gửi.
                        </p>
                      </div>
                      <StatusBadge status={selected.status} />
                    </div>
                    {canReply && !replyBlockReason ? (
                      <div className="mt-3 grid gap-2">
                        <SelectInput
                          disabled={templates.length === 0}
                          value=""
                          onChange={(event) => {
                            const template = templates.find(
                              (item) => item.id === event.target.value,
                            );
                            if (template) setReplyBody(template.body);
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
                          placeholder="Nhập câu trả lời cho khách..."
                          value={replyBody}
                          onChange={(event) => setReplyBody(event.target.value)}
                        />
                        <div className="flex flex-wrap justify-end gap-2">
                          <SecondaryButton
                            disabled={!replyBody}
                            onClick={() => setReplyBody('')}
                            type="button"
                          >
                            Xóa nội dung
                          </SecondaryButton>
                          <PrimaryButton
                            disabled={!replyBody.trim() || busy !== null}
                            onClick={() =>
                              void mutateComment('reply', async () => {
                                await commentsApi.reply(workspace.id, selected.id, replyBody);
                                setReplyBody('');
                              })
                            }
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
                    <h3 className="text-sm font-semibold text-slate-950">Internal notes</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Note chỉ dùng trong workspace, không gửi ra nền tảng.
                    </p>
                    <div className="mt-3 grid gap-2">
                      <textarea
                        className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                        placeholder="Ghi chú cho team..."
                        value={noteBody}
                        onChange={(event) => setNoteBody(event.target.value)}
                      />
                      <SecondaryButton
                        disabled={!noteBody.trim() || busy !== null}
                        onClick={() =>
                          void mutateComment('note', async () => {
                            await commentsApi.addNote(workspace.id, selected.id, noteBody);
                            setNoteBody('');
                          })
                        }
                        type="button"
                      >
                        Thêm note
                      </SecondaryButton>
                    </div>
                    <div className="mt-3 space-y-2">
                      {selected.notes.map((note) => (
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
                      {selected.notes.length === 0 ? (
                        <p className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500">
                          Chưa có note nội bộ.
                        </p>
                      ) : null}
                    </div>
                  </section>
                </main>

                <aside className="space-y-5 border-t border-slate-200 p-5 xl:border-l xl:border-t-0">
                  <section>
                    <h3 className="text-sm font-semibold text-slate-950">Workflow</h3>
                    <div className="mt-3 space-y-3">
                      <Field label="Status">
                        <SelectInput
                          disabled={!canModerate || busy !== null}
                          value={selected.status}
                          onChange={(event) =>
                            void mutateComment('status', () =>
                              commentsApi.updateStatus(
                                workspace.id,
                                selected.id,
                                event.target.value as CommentView['status'],
                              ),
                            )
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
                          value={selected.assignment?.memberId ?? ''}
                          onChange={(event) =>
                            void mutateComment('assign', () =>
                              commentsApi.assign(
                                workspace.id,
                                selected.id,
                                event.target.value || null,
                              ),
                            )
                          }
                        >
                          <option value="">Chưa gán</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name ?? member.email}
                            </option>
                          ))}
                        </SelectInput>
                      </Field>
                      <Field label="Thêm tag">
                        <SelectInput
                          disabled={!canModerate || busy !== null}
                          value=""
                          onChange={(event) => {
                            const next = event.target.value;
                            if (!next) return;
                            const tagIds = new Set(selected.tags.map((tag) => tag.id));
                            tagIds.add(next);
                            void mutateComment('tags', () =>
                              commentsApi.updateTags(workspace.id, selected.id, [...tagIds]),
                            );
                          }}
                        >
                          <option value="">Chọn tag</option>
                          {tags.map((tag) => (
                            <option key={tag.id} value={tag.id}>
                              {tag.name}
                            </option>
                          ))}
                        </SelectInput>
                      </Field>
                    </div>
                    {selected.tags.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {selected.tags.map((tag) => (
                          <button
                            key={tag.id}
                            className="rounded-full px-2.5 py-1 text-xs font-medium text-white"
                            disabled={!canModerate || busy !== null}
                            onClick={() =>
                              void mutateComment('tags', () =>
                                commentsApi.updateTags(
                                  workspace.id,
                                  selected.id,
                                  selected.tags
                                    .filter((item) => item.id !== tag.id)
                                    .map((item) => item.id),
                                ),
                              )
                            }
                            style={{ backgroundColor: tag.color }}
                            type="button"
                          >
                            {tag.name} ×
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </section>

                  <section className="rounded-lg border border-slate-200 p-3">
                    <h3 className="text-sm font-semibold text-slate-950">Tạo tag</h3>
                    <div className="mt-3 grid gap-3">
                      <Field label="Tên tag">
                        <TextInput
                          value={newTagName}
                          onChange={(event) => setNewTagName(event.target.value)}
                        />
                      </Field>
                      <Field label="Màu">
                        <SelectInput
                          value={newTagColor}
                          onChange={(event) => setNewTagColor(event.target.value)}
                        >
                          {TAG_COLORS.map((color) => (
                            <option key={color} value={color}>
                              {color}
                            </option>
                          ))}
                        </SelectInput>
                      </Field>
                      <SecondaryButton
                        disabled={!canModerate || !newTagName.trim() || busy !== null}
                        onClick={() =>
                          void mutateStatic('create-tag', async () => {
                            await commentsApi.createTag(workspace.id, {
                              name: newTagName.trim(),
                              color: newTagColor,
                            });
                            setNewTagName('');
                          })
                        }
                        type="button"
                      >
                        Tạo tag
                      </SecondaryButton>
                    </div>
                  </section>

                  <section className="rounded-lg border border-slate-200 p-3">
                    <h3 className="text-sm font-semibold text-slate-950">Quick replies</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Đây là nơi lưu mẫu trả lời để dùng lại trong ô Reply.
                    </p>
                    <div className="mt-3 grid gap-2">
                      <TextInput
                        placeholder="Tên mẫu"
                        value={newTemplateName}
                        onChange={(event) => setNewTemplateName(event.target.value)}
                      />
                      <textarea
                        className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                        placeholder="Nội dung mẫu"
                        value={newTemplateBody}
                        onChange={(event) => setNewTemplateBody(event.target.value)}
                      />
                      <SecondaryButton
                        disabled={
                          !canReply ||
                          !newTemplateName.trim() ||
                          !newTemplateBody.trim() ||
                          busy !== null
                        }
                        onClick={() =>
                          void mutateStatic('template', async () => {
                            await commentsApi.createTemplate(workspace.id, {
                              name: newTemplateName,
                              body: newTemplateBody,
                            });
                            setNewTemplateName('');
                            setNewTemplateBody('');
                          })
                        }
                        type="button"
                      >
                        Lưu quick reply
                      </SecondaryButton>
                    </div>
                    {templates.length > 0 ? (
                      <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200">
                        {templates.map((template) => (
                          <div key={template.id} className="px-3 py-2">
                            <div className="flex items-start justify-between gap-3">
                              <button
                                className="min-w-0 flex-1 text-left"
                                onClick={() => setReplyBody(template.body)}
                                type="button"
                              >
                                <p className="truncate text-sm font-medium text-slate-900">
                                  {template.name}
                                </p>
                                <p className="line-clamp-2 text-xs text-slate-500">
                                  {template.body}
                                </p>
                              </button>
                              <button
                                className="text-xs font-semibold text-slate-500 hover:text-red-600"
                                disabled={!canReply || busy !== null}
                                onClick={() =>
                                  void mutateStatic('delete-template', () =>
                                    commentsApi.deleteTemplate(workspace.id, template.id),
                                  )
                                }
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
          ) : (
            <div className="p-6">
              <p className="text-sm font-semibold text-slate-950">Chưa chọn comment</p>
              <p className="mt-1 text-sm text-slate-600">
                Chọn một comment ở danh sách bên trái để xem conversation, reply, note và workflow.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'RESOLVED'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'PENDING'
        ? 'bg-amber-50 text-amber-700'
        : 'bg-slate-100 text-slate-600';

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
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
      className={`inline-flex h-11 items-center justify-between gap-3 rounded-md border px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        active
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      }`}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${
          active ? 'bg-white text-brand-700' : 'bg-slate-100 text-slate-500'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function CommentBubble({
  comment,
  highlight = false,
}: {
  comment: CommentView;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        highlight ? 'border-slate-300 bg-white' : 'ml-8 border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-950">
          {comment.authorName ?? 'Unknown author'}
        </p>
        <p className="text-xs text-slate-500">{formatDateTime(comment.postedAt)}</p>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
        {comment.message ?? 'Không có nội dung.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {comment.isFromPage ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            Comment của page
          </span>
        ) : null}
        {comment.likeCount ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {comment.likeCount} likes
          </span>
        ) : null}
      </div>
    </div>
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

function buildCommentRows(comments: CommentView[]): Array<{ comment: CommentView; depth: number }> {
  const childrenByParent = new Map<string | null, CommentView[]>();
  for (const comment of comments) {
    const parentId = comments.some((item) => item.id === comment.parentId)
      ? comment.parentId
      : null;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(comment);
    childrenByParent.set(parentId, children);
  }

  const rows: Array<{ comment: CommentView; depth: number }> = [];
  const visit = (items: CommentView[], depth: number) => {
    for (const comment of items) {
      rows.push({ comment, depth });
      visit(childrenByParent.get(comment.id) ?? [], depth + 1);
    }
  };
  visit(childrenByParent.get(null) ?? [], 0);
  return rows;
}
