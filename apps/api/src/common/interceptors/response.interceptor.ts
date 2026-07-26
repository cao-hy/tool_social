import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { buildMeta, successResponse, type ApiSuccessResponse } from '@socialhub/shared';
import { map, type Observable } from 'rxjs';
import { getRequestId } from '../request-context';

/** Đánh dấu response không cần bọc envelope (health check cho load balancer...). */
export const RAW_RESPONSE = Symbol('RAW_RESPONSE');

export interface RawResponse<T> {
  [RAW_RESPONSE]: true;
  value: T;
}

export function raw<T>(value: T): RawResponse<T> {
  return { [RAW_RESPONSE]: true, value };
}

function isRaw(value: unknown): value is RawResponse<unknown> {
  return typeof value === 'object' && value !== null && RAW_RESPONSE in value;
}

/**
 * Bọc mọi response thành công vào envelope thống nhất — ARCHITECTURE.md §7.1.
 *
 * Đặt ở đây thay vì để từng controller tự bọc: một controller quên bọc là một
 * điểm bất nhất mà client phải xử lý riêng, và loại lỗi đó rất khó phát hiện
 * khi review.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<unknown>();
    const requestId = getRequestId(request);

    return next.handle().pipe(
      map((data: unknown): unknown => {
        if (isRaw(data)) return data.value;
        return successResponse(data, buildMeta(requestId)) satisfies ApiSuccessResponse<unknown>;
      }),
    );
  }
}
