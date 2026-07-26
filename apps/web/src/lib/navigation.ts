/**
 * Cấu trúc điều hướng theo prompt §13.
 *
 * `phase` cho biết trang đó được triển khai ở phase nào — sidebar hiển thị
 * trang chưa làm ở trạng thái disabled kèm nhãn phase, thay vì giấu đi. Người
 * dùng thấy được sản phẩm sẽ đi tới đâu, và không ai bấm vào một trang trống.
 */
export interface NavItem {
  label: string;
  href: string;
  phase: number;
  description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', phase: 8, description: 'Tổng quan hiệu suất' },
  { label: 'Calendar', href: '/calendar', phase: 4, description: 'Lịch đăng bài' },
  { label: 'Create Post', href: '/posts/new', phase: 4, description: 'Soạn nội dung đa nền tảng' },
  { label: 'Posts', href: '/posts', phase: 6, description: 'Danh sách và trạng thái bài đăng' },
  { label: 'Inbox', href: '/inbox', phase: 7, description: 'Comment từ mọi nền tảng' },
  { label: 'Analytics', href: '/analytics', phase: 8, description: 'Phân tích chi tiết' },
  { label: 'Social Accounts', href: '/accounts', phase: 3, description: 'Kết nối tài khoản' },
  { label: 'Team', href: '/team', phase: 2, description: 'Thành viên và phân quyền' },
  { label: 'Notifications', href: '/notifications', phase: 2, description: 'Thông báo' },
  { label: 'Settings', href: '/settings', phase: 2, description: 'Cấu hình workspace' },
];

export const CURRENT_PHASE = 1;

export function isAvailable(item: NavItem): boolean {
  return item.phase <= CURRENT_PHASE;
}
