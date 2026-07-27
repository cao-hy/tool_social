import { Inject, Injectable } from '@nestjs/common';
import { redactSensitive } from '@socialhub/shared';
import type { AuditAction, Prisma } from '@socialhub/db';
import { logger } from '../../common/logger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface AuditContext {
  actorUserId?: string;
  actorIp?: string;
  actorUserAgent?: string | string[];
  requestId?: string;
}

export interface AuditRecordInput extends AuditContext {
  workspaceId?: string;
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorIp: input.actorIp,
          actorUserAgent: Array.isArray(input.actorUserAgent)
            ? input.actorUserAgent.join(', ')
            : input.actorUserAgent,
          requestId: input.requestId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          before: this.toJson(input.before),
          after: this.toJson(input.after),
          metadata: this.toJson(input.metadata),
        },
      });
    } catch (error) {
      logger.error({ err: error, action: input.action }, 'Ghi audit log thất bại');
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    return redactSensitive(value) as Prisma.InputJsonValue;
  }
}
