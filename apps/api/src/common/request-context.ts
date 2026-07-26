import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Mỗi request có một ID, truyền tiếp vào job payload và xuống tận adapter.
 *
 * Nhờ vậy một sự cố "bài đăng của tôi không lên" truy được từ log HTTP → log
 * queue → log adapter bằng một chuỗi tìm kiếm duy nhất, xuyên qua ba process
 * (ARCHITECTURE.md §10).
 */
export function resolveRequestId(request: FastifyRequest): string {
  const incoming = request.headers[REQUEST_ID_HEADER];
  if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return randomUUID();
}

export function attachRequestId(request: FastifyRequest, reply: FastifyReply): string {
  const requestId = resolveRequestId(request);
  (request as FastifyRequest & { requestId?: string }).requestId = requestId;
  void reply.header(REQUEST_ID_HEADER, requestId);
  return requestId;
}

export function getRequestId(request: unknown): string {
  const candidate = (request as { requestId?: unknown } | null)?.requestId;
  return typeof candidate === 'string' ? candidate : 'unknown';
}
