/**
 * Hỗ trợ hủy / consume HTTP response body để đảm bảo giải phóng `activeRequests` lease
 * trong Undici proxied fetch dispatcher khi caller không cần đọc nội dung response.
 */
export async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Body có thể đã được consume hoặc đã đóng trước đó
  }
}
