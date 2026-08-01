import { Inject, Injectable } from '@nestjs/common';
import type { JobStatus } from '@socialhub/db';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ListJobActivityQuery } from './jobs.schemas';

const ACTIVE_STATUSES: JobStatus[] = ['QUEUED', 'RUNNING', 'FAILED', 'DEAD'];

@Injectable()
export class JobsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async activity(workspaceId: string, query: ListJobActivityQuery) {
    const activeJobs = await this.prisma.backgroundJob.findMany({
      where: { workspaceId, status: { in: ACTIVE_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      take: query.limit,
    });
    const completedJobs = query.includeCompleted
      ? await this.prisma.backgroundJob.findMany({
          where: {
            workspaceId,
            status: 'COMPLETED',
            updatedAt: { gte: new Date(Date.now() - 1000 * 60 * 5) },
          },
          orderBy: { updatedAt: 'desc' },
          take: Math.max(0, query.limit - activeJobs.length),
        })
      : [];
    const jobs = [...activeJobs, ...completedJobs].slice(0, query.limit);

    return {
      generatedAt: new Date().toISOString(),
      activeCount: jobs.filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING').length,
      failedCount: jobs.filter((job) => job.status === 'FAILED' || job.status === 'DEAD').length,
      items: jobs
        .sort((left, right) => scoreJob(right.status) - scoreJob(left.status))
        .map((job) => ({
          id: job.id,
          queueName: job.queueName,
          jobId: job.jobId,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          startedAt: job.startedAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          durationMs: job.durationMs,
          errorCode: job.errorCode,
          errorMessage: job.errorMessage,
          isDead: job.isDead,
          correlationId: job.correlationId,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          label: labelJob(job.queueName),
        })),
    };
  }
}

function scoreJob(status: JobStatus): number {
  switch (status) {
    case 'RUNNING':
      return 5;
    case 'QUEUED':
      return 4;
    case 'FAILED':
      return 3;
    case 'DEAD':
      return 2;
    case 'COMPLETED':
      return 1;
  }
}

function labelJob(queueName: string): string {
  switch (queueName) {
    case 'publish-post':
    case 'retry-failed-post':
      return 'Đăng bài';
    case 'sync-comments':
      return 'Đồng bộ comment';
    case 'sync-post-metrics':
      return 'Đồng bộ metric bài';
    case 'sync-account-metrics':
      return 'Đồng bộ metric tài khoản';
    case 'refresh-social-token':
      return 'Làm mới token';
    case 'process-webhook':
      return 'Xử lý webhook';
    case 'generate-thumbnail':
      return 'Tạo thumbnail';
    case 'cleanup-unused-media':
      return 'Dọn media';
    case 'sync-posts':
      return 'Đồng bộ bài đăng';
    default:
      return queueName;
  }
}
