import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class AuditLogsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(workspaceId: string): Promise<{
    items: Array<{
      id: string;
      action: string;
      actorUserId: string | null;
      actorIp: string | null;
      actorUserAgent: string | null;
      requestId: string | null;
      resourceType: string | null;
      resourceId: string | null;
      before: unknown;
      after: unknown;
      metadata: unknown;
      createdAt: Date;
    }>;
  }> {
    const logs = await this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      items: logs.map((log) => ({
        id: log.id,
        action: log.action,
        actorUserId: log.actorUserId,
        actorIp: log.actorIp,
        actorUserAgent: log.actorUserAgent,
        requestId: log.requestId,
        resourceType: log.resourceType,
        resourceId: log.resourceId,
        before: log.before,
        after: log.after,
        metadata: log.metadata,
        createdAt: log.createdAt,
      })),
    };
  }
}
