import { CheckCircle2, MessageSquare, X } from 'lucide-react';
import { PrimaryButton } from './form-controls';

export interface BulkActionBarProps {
  selectionMode: 'posts' | 'comments' | null;
  selectedCount: number;
  onClearSelection: () => void;
  onBulkCommentClick?: () => void;
  onBulkReplyClick?: () => void;
  canReply?: boolean;
}

export function BulkActionBar({
  selectionMode,
  selectedCount,
  onClearSelection,
  onBulkCommentClick,
  onBulkReplyClick,
  canReply = true,
}: BulkActionBarProps) {
  if (!selectionMode || selectedCount === 0) return null;

  return (
    <div className="sticky top-4 z-30 mb-4 flex w-full items-center justify-between rounded-lg border border-brand-200 bg-brand-50 p-3 shadow-md">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 font-semibold text-brand-800">
          <CheckCircle2 className="h-5 w-5" />
          <span>
            Đã chọn {selectedCount} {selectionMode === 'posts' ? 'bài đăng' : 'comment'}
          </span>
        </div>

        <div className="h-6 w-px bg-brand-200" />

        <div className="flex items-center gap-2">
          {selectionMode === 'posts' ? (
            <PrimaryButton
              type="button"
              onClick={onBulkCommentClick}
              disabled={!canReply}
              title={!canReply ? 'Bạn không có quyền comment' : undefined}
            >
              <MessageSquare className="mr-2 h-4 w-4" />
              Comment vào các bài đã chọn
            </PrimaryButton>
          ) : (
            <>
              <PrimaryButton
                type="button"
                onClick={onBulkReplyClick}
                disabled={!canReply}
                title={!canReply ? 'Bạn không có quyền reply' : undefined}
              >
                <MessageSquare className="mr-2 h-4 w-4" />
                Reply các comment đã chọn
              </PrimaryButton>
              {/* <SecondaryButton type="button">
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Đánh dấu đã xong
              </SecondaryButton>
              <SecondaryButton type="button">
                <UserRound className="mr-2 h-4 w-4" />
                Gán người xử lý
              </SecondaryButton>
              <SecondaryButton type="button">
                <Tag className="mr-2 h-4 w-4" />
                Thêm tag
              </SecondaryButton> */}
            </>
          )}
        </div>
      </div>

      <button
        onClick={onClearSelection}
        className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-semibold text-slate-600 transition hover:bg-brand-100 hover:text-slate-900"
        title="Bỏ chọn (Esc)"
        type="button"
      >
        <X className="mr-2 h-4 w-4" />
        Bỏ chọn
      </button>
    </div>
  );
}
