import { X } from 'lucide-react';
import { useState } from 'react';
import { PrimaryButton, SecondaryButton, SelectInput } from './form-controls';
import type { CommentView, ReplyTemplateView } from '@/lib/types';
import { PLATFORM_LABELS, type Platform } from '@socialhub/shared';

export interface BulkCommentReplyDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  selectedCommentIds: Set<string>;
  comments: CommentView[];
  templates: ReplyTemplateView[];
  onSubmit: (message: string) => Promise<void>;
  busy: boolean;
}

export function BulkCommentReplyDrawer({
  isOpen,
  onClose,
  selectedCommentIds,
  comments,
  templates,
  onSubmit,
  busy,
}: BulkCommentReplyDrawerProps) {
  const [message, setMessage] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  if (!isOpen) return null;

  const selectedComments = comments.filter((c) => selectedCommentIds.has(c.id));
  const uniqueUsers = new Set(
    selectedComments.map((c) => c.authorName ?? c.authorExternalId ?? 'Unknown'),
  ).size;

  const platformCounts = selectedComments.reduce(
    (acc, curr) => {
      acc[curr.platform] = (acc[curr.platform] || 0) + 1;
      return acc;
    },
    {} as Record<Platform, number>,
  );

  const handleSend = async () => {
    if (!message.trim()) return;
    await onSubmit(message);
    setMessage('');
    setShowPreview(false);
  };

  const renderPersonalizedMessage = (baseMessage: string, comment: CommentView) => {
    const authorName = comment.authorName || 'Bạn';
    const parts = authorName.trim().split(' ');
    const firstName = parts[parts.length - 1] || 'Bạn';

    return baseMessage
      .replace(/\{\{full_name\}\}/g, authorName)
      .replace(/\{\{first_name\}\}/g, firstName);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-40 xl:pointer-events-auto xl:static xl:z-auto xl:block xl:h-[calc(100vh-220px)] xl:min-h-[560px]">
      <button
        aria-label="Đóng"
        className="pointer-events-auto absolute inset-0 bg-slate-950/20 xl:hidden cursor-default"
        onClick={onClose}
        type="button"
      />
      <aside className="pointer-events-auto absolute right-0 top-0 flex h-full w-[85%] max-w-sm flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl xl:static xl:w-full xl:max-w-none xl:rounded-md xl:border xl:shadow-none">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Reply {selectedCommentIds.size} comment đã chọn
            </h2>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
              <span className="rounded-md bg-slate-100 px-2 py-1">{uniqueUsers} người dùng</span>
              {Object.entries(platformCounts).map(([platform, count]) => (
                <span key={platform} className="rounded-md bg-slate-100 px-2 py-1">
                  {count} {PLATFORM_LABELS[platform as Platform]}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
          {showPreview ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Xem trước hiển thị cá nhân hóa
              </h3>
              <p className="text-xs text-slate-500">
                Các biến mẫu như {'{{first_name}}'} được thay thế tự động.
              </p>
              {selectedComments.slice(0, 5).map((comment) => (
                <div key={comment.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-900">
                      {comment.authorName ?? 'Unknown'}
                    </p>
                  </div>
                  <div className="mt-2 rounded bg-slate-50 p-2">
                    <p className="text-xs text-slate-500 italic">
                      "{(comment.message ?? '').slice(0, 60)}
                      {comment.message && comment.message.length > 60 ? '...' : ''}"
                    </p>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-brand-700 font-medium">
                    {renderPersonalizedMessage(message, comment)}
                  </p>
                </div>
              ))}
              {selectedComments.length > 5 && (
                <p className="text-center text-xs text-slate-500">
                  ...và {selectedComments.length - 5} comment khác
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {templates.length > 0 && (
                <div>
                  <label className="block text-sm font-semibold text-slate-900">
                    Mẫu trả lời (Quick reply)
                  </label>
                  <SelectInput
                    className="mt-2"
                    value=""
                    onChange={(event) => {
                      const template = templates.find((item) => item.id === event.target.value);
                      if (template) setMessage(template.body);
                    }}
                  >
                    <option value="">Chọn quick reply</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </SelectInput>
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold text-slate-900">Nội dung reply</label>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMessage((m) => m + '{{full_name}}')}
                    className="rounded bg-slate-100 px-2 py-1 text-xs font-mono text-slate-600 hover:bg-slate-200"
                  >
                    {'{'}
                    {'{'}full_name{'}'}
                    {'}'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMessage((m) => m + '{{first_name}}')}
                    className="rounded bg-slate-100 px-2 py-1 text-xs font-mono text-slate-600 hover:bg-slate-200"
                  >
                    {'{'}
                    {'{'}first_name{'}'}
                    {'}'}
                  </button>
                </div>
                <textarea
                  className="mt-2 min-h-[160px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  maxLength={2000}
                  placeholder="Nhập nội dung reply..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="mt-1 text-right text-xs text-slate-500">{message.length}/2000</div>
              </div>
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <SecondaryButton onClick={onClose} disabled={busy} type="button">
              Hủy
            </SecondaryButton>
            <div className="flex gap-2">
              <SecondaryButton
                onClick={() => setShowPreview(!showPreview)}
                disabled={busy || !message.trim()}
                type="button"
              >
                {showPreview ? 'Chỉnh sửa' : 'Xem trước'}
              </SecondaryButton>
              <PrimaryButton onClick={handleSend} disabled={busy || !message.trim()} type="button">
                {busy ? 'Đang gửi...' : `Đưa ${selectedCommentIds.size} reply vào hàng đợi`}
              </PrimaryButton>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  );
}
