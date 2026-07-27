import { Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { AppError } from '../errors/app-error';

/**
 * Validate DTO bằng Zod — ARCHITECTURE.md §7, SECURITY.md §7.1.
 *
 * Dùng Zod (không phải class-validator) vì cùng một schema được dùng lại ở
 * frontend: một định nghĩa duy nhất cho luật hợp lệ, thay vì hai bản có nguy cơ
 * lệch nhau theo thời gian.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw AppError.validation(
          'Dữ liệu gửi lên không hợp lệ.',
          error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

export function zodPipe<T>(schema: ZodType<T, ZodTypeDef, unknown>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
