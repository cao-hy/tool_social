import type { ApiResponse } from '@socialhub/shared';

/**
 * Client gọi API.
 *
 * `credentials: 'include'` là bắt buộc: session nằm trong HTTP-only cookie, và
 * frontend KHÔNG BAO GIỜ giữ token (SECURITY.md §2.3 quy tắc 1). Cách này đồng
 * nghĩa trình duyệt tự gửi cookie, còn JavaScript thì không đọc được nó — kể cả
 * khi có lỗ hổng XSS.
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function getApiBaseUrl(): string {
  // Next.js thay biến NEXT_PUBLIC_* lúc build; đọc trực tiếp là cách duy nhất
  // để việc thay thế đó hoạt động (không dùng được @socialhub/config ở client).
  // eslint-disable-next-line no-restricted-properties
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) {
    throw new Error(
      'Thiếu NEXT_PUBLIC_API_BASE_URL. Sao chép .env.example thành .env trước khi chạy.',
    );
  }
  return url.replace(/\/$/, '');
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  const body = (await response.json()) as ApiResponse<T>;

  if (!body.success) {
    throw new ApiClientError(
      body.error.code,
      body.error.message,
      response.status,
      body.error.details,
      body.meta.requestId,
    );
  }

  return body.data;
}
