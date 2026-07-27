import { ApiClientError } from './api-client';

function getValidationDetails(details: unknown): string | null {
  if (!Array.isArray(details)) return null;

  const messages = details
    .map((detail) => {
      if (typeof detail !== 'object' || detail === null) return null;
      const field = 'field' in detail && typeof detail.field === 'string' ? detail.field : null;
      const message =
        'message' in detail && typeof detail.message === 'string' ? detail.message : null;
      if (!message) return null;
      return field ? `${field}: ${message}` : message;
    })
    .filter((message): message is string => Boolean(message));

  return messages.length > 0 ? messages.join('; ') : null;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return getValidationDetails(error.details) ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}
