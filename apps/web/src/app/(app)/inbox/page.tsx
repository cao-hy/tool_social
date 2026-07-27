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
  const commentRows = useMemo(() => buildCommentRows(comments), [comments]);

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

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Inbox</h1>
          <p className="mt-1 text-sm text-slate-600">
            Comment từ các nền tảng, assignment, tag, note nội bộ và reply template.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={loading} onClick={() => void loadComments()} type="button">
            Làm mới
          </SecondaryButton>
          <SecondaryButton
            disabled={!canModerate || busy !== null || accounts.length === 0 || !!syncBlockReason}
            onClick={() => void syncSelectedAccount()}
            title={syncBlockReason ?? undefined}
            type="button"
          >
            {busy === 'sync' ? 'Đang queue...' : 'Sync comments'}
          </SecondaryButton>
        </div>
      </header>

      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </div>
      ) : null}
      <InlineError message={error} />

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Từ khóa">
            <TextInput value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Field label="Trạng thái">
            <SelectInput value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Tất cả</option>
              {STATUSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Nền tảng">
            <SelectInput
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setSocialAccountId('');
              }}
            >
              <option value="">Tất cả</option>
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
              <option value="">Tất cả</option>
              {accounts
                .filter((account) => !platform || account.platform === platform)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </SelectInput>
          </Field>
          <Field label="Assignee">
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
              <option value="">Tất cả</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-semibold text-slate-950">
              {loading ? 'Đang tải...' : `${comments.length} comments`}
            </p>
          </div>
          <div className="max-h-[720px] divide-y divide-slate-200 overflow-y-auto">
            {commentRows.map(({ comment, depth }) => (
              <button
                key={comment.id}
                className={`block w-full px-4 py-3 text-left transition hover:bg-slate-50 ${
                  selectedId === comment.id ? 'bg-brand-50' : 'bg-white'
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
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {PLATFORM_LABELS[comment.platform]}
                  </span>
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
              <p className="p-5 text-sm text-slate-600">Chưa có comment nào khớp filter.</p>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          {selected ? (
            <div className="space-y-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={selected.status} />
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    {PLATFORM_LABELS[selected.platform]}
                  </span>
                  {selected.isFromPage ? (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                      From page
                    </span>
                  ) : null}
                </div>
                <h2 className="mt-3 text-lg font-semibold text-slate-950">
                  {selected.authorName ?? 'Unknown author'}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {selected.socialAccountName} · {formatDateTime(selected.postedAt)}
                </p>
                <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">
                  {selected.message ?? 'Không có nội dung.'}
                </p>
                <p className="mt-3 text-xs text-slate-500">
                  Post: {selected.contentPostTitle ?? selected.contentPostId}
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
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
                        {item}
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
                        commentsApi.assign(workspace.id, selected.id, event.target.value || null),
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
                <Field label="Tag">
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
                    <option value="">Thêm tag</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </div>

              {selected.tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
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

              <section className="grid gap-3 md:grid-cols-[1fr_140px]">
                <Field label="Tag mới">
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
                  className="md:col-span-2"
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
              </section>

              <section>
                <h3 className="text-sm font-semibold text-slate-950">Reply</h3>
                {canReply && !replyBlockReason ? (
                  <div className="mt-2 grid gap-2">
                    <SelectInput
                      disabled={templates.length === 0}
                      value=""
                      onChange={(event) => {
                        const template = templates.find((item) => item.id === event.target.value);
                        if (template) setReplyBody(template.body);
                      }}
                    >
                      <option value="">Chọn template</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </SelectInput>
                    <textarea
                      className="min-h-28 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      value={replyBody}
                      onChange={(event) => setReplyBody(event.target.value)}
                    />
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
                ) : (
                  <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {replyBlockReason ?? 'Vai trò hiện tại không có quyền reply comment.'}
                  </p>
                )}
              </section>

              <section>
                <h3 className="text-sm font-semibold text-slate-950">Notes</h3>
                <div className="mt-2 grid gap-2">
                  <textarea
                    className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
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
                </div>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-slate-950">Reply templates</h3>
                <div className="mt-2 grid gap-2">
                  <TextInput
                    placeholder="Tên template"
                    value={newTemplateName}
                    onChange={(event) => setNewTemplateName(event.target.value)}
                  />
                  <textarea
                    className="min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    placeholder="Nội dung template"
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
                    Lưu template
                  </SecondaryButton>
                </div>
                {templates.length > 0 ? (
                  <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200">
                    {templates.map((template) => (
                      <div
                        key={template.id}
                        className="flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {template.name}
                          </p>
                          <p className="line-clamp-1 text-xs text-slate-500">{template.body}</p>
                        </div>
                        <SecondaryButton
                          disabled={!canReply || busy !== null}
                          onClick={() =>
                            void mutateStatic('delete-template', () =>
                              commentsApi.deleteTemplate(workspace.id, template.id),
                            )
                          }
                          type="button"
                        >
                          Xóa
                        </SecondaryButton>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          ) : (
            <p className="text-sm text-slate-600">Chọn một comment để xem chi tiết.</p>
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

  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>;
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
