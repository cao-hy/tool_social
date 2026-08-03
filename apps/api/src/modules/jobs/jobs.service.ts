import { Inject, Injectable } from '@nestjs/common';
import type {
  BackgroundJob,
  ExternalPostSyncJob,
  JobStatus,
  Platform,
  SocialAccount,
} from '@socialhub/db';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ListJobActivityQuery } from './jobs.schemas';

const ACTIVE_STATUSES: JobStatus[] = ['QUEUED', 'RUNNING', 'FAILED', 'DEAD'];
const TERMINAL_STATUSES: JobStatus[] = ['COMPLETED', 'FAILED', 'DEAD'];
const STALE_QUEUED_AFTER_MS = 10 * 60 * 1000;

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
    const context = await this.loadJobContext(workspaceId, jobs);

    return {
      generatedAt: new Date().toISOString(),
      activeCount: jobs.filter((job) => isActiveJob(job)).length,
      failedCount: jobs.filter((job) => job.status === 'FAILED' || job.status === 'DEAD').length,
      staleQueuedCount: jobs.filter((job) => isStaleQueued(job)).length,
      items: jobs.sort(compareJobsForActivity).map((job) => mapJob(job, context)),
    };
  }

  async status(workspaceId: string, ids: string[]) {
    const jobs = await this.prisma.backgroundJob.findMany({
      where: { workspaceId, id: { in: ids } },
      orderBy: { updatedAt: 'desc' },
    });
    const context = await this.loadJobContext(workspaceId, jobs);
    const mapped = new Map(jobs.map((job) => [job.id, mapJob(job, context)]));
    return {
      generatedAt: new Date().toISOString(),
      items: ids.map((id) => mapped.get(id)).filter((job): job is NonNullable<typeof job> => !!job),
      doneCount: jobs.filter((job) => TERMINAL_STATUSES.includes(job.status)).length,
      activeCount: jobs.filter((job) => isActiveJob(job)).length,
      failedCount: jobs.filter((job) => job.status === 'FAILED' || job.status === 'DEAD').length,
      staleQueuedCount: jobs.filter((job) => isStaleQueued(job)).length,
    };
  }

  async clearFailed(workspaceId: string) {
    await this.prisma.backgroundJob.deleteMany({
      where: {
        workspaceId,
        status: { in: ['FAILED', 'DEAD'] },
      },
    });
    return { cleared: true };
  }

  async clearStaleQueued(workspaceId: string) {
    const threshold = new Date(Date.now() - STALE_QUEUED_AFTER_MS);
    const result = await this.prisma.backgroundJob.deleteMany({
      where: {
        workspaceId,
        status: 'QUEUED',
        updatedAt: { lt: threshold },
      },
    });
    return { cleared: result.count };
  }

  private async loadJobContext(workspaceId: string, jobs: BackgroundJob[]) {
    const socialAccountIds = new Set<string>();
    const externalSyncJobIds = new Set<string>();

    for (const job of jobs) {
      const payload = jsonObject(job.payload);
      const socialAccountId = stringField(payload, 'socialAccountId');
      if (socialAccountId) socialAccountIds.add(socialAccountId);
      if (job.queueName === 'sync-external-posts' && job.correlationId) {
        externalSyncJobIds.add(job.correlationId);
      }
    }

    const [accounts, externalSyncJobs] = await Promise.all([
      socialAccountIds.size > 0
        ? this.prisma.socialAccount.findMany({
            where: { workspaceId, id: { in: [...socialAccountIds] } },
            select: { id: true, platform: true, name: true, username: true },
          })
        : [],
      externalSyncJobIds.size > 0
        ? this.prisma.externalPostSyncJob.findMany({
            where: { workspaceId, id: { in: [...externalSyncJobIds] } },
          })
        : [],
    ]);

    return {
      accountsById: new Map(accounts.map((account) => [account.id, account])),
      externalSyncJobsById: new Map(externalSyncJobs.map((job) => [job.id, job])),
    };
  }
}

type JobContext = Awaited<ReturnType<JobsService['loadJobContext']>>;

function mapJob(job: BackgroundJob, context: JobContext) {
  const payload = jsonObject(job.payload);
  const account = accountForJob(payload, context);
  const externalSyncJob =
    job.queueName === 'sync-external-posts' && job.correlationId
      ? context.externalSyncJobsById.get(job.correlationId)
      : undefined;

  return {
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
    details: detailsForJob(job, payload, account, externalSyncJob),
    progress: progressForJob(job, externalSyncJob),
    isStaleQueued: isStaleQueued(job),
  };
}

function accountForJob(
  payload: Record<string, unknown> | null,
  context: JobContext,
): Pick<SocialAccount, 'id' | 'platform' | 'name' | 'username'> | undefined {
  const socialAccountId = stringField(payload, 'socialAccountId');
  return socialAccountId ? context.accountsById.get(socialAccountId) : undefined;
}

function detailsForJob(
  job: BackgroundJob,
  payload: Record<string, unknown> | null,
  account: Pick<SocialAccount, 'id' | 'platform' | 'name' | 'username'> | undefined,
  externalSyncJob: ExternalPostSyncJob | undefined,
): string | null {
  if (externalSyncJob) {
    return `${platformLabel(externalSyncJob.platform)} · ${account?.name ?? 'Tài khoản'} · quét ${externalSyncJob.scannedCount}, mới ${externalSyncJob.importedCount}, cập nhật ${externalSyncJob.updatedCount}`;
  }
  if (account) {
    return `${platformLabel(account.platform)} · ${account.name}${account.username ? ` · @${account.username}` : ''}`;
  }
  if (job.queueName === 'sync-post-metrics') {
    return `Bài ${stringField(payload, 'platformPostId') ?? ''}`.trim();
  }
  if (job.queueName === 'sync-account-metrics') {
    return `Tài khoản ${stringField(payload, 'socialAccountId') ?? ''}`.trim();
  }
  if (job.queueName === 'publish-post' || job.queueName === 'retry-failed-post') {
    return `Target ${stringField(payload, 'platformPostId') ?? ''}`.trim();
  }
  if (job.queueName === 'generate-thumbnail') {
    return `Media ${stringField(payload, 'mediaAssetId') ?? ''}`.trim();
  }
  return null;
}

function progressForJob(
  job: BackgroundJob,
  externalSyncJob: ExternalPostSyncJob | undefined,
): {
  mode: 'KNOWN' | 'INDETERMINATE';
  current: number;
  total: number | null;
  percent: number | null;
  label: string;
  counts?: Record<string, number>;
} | null {
  if (externalSyncJob) {
    const processed =
      externalSyncJob.scannedCount + externalSyncJob.skippedCount + externalSyncJob.failedCount;
    return {
      mode: 'INDETERMINATE',
      current: processed,
      total: null,
      percent: null,
      label:
        externalSyncJob.status === 'COMPLETED'
          ? 'Đồng bộ lịch sử xong'
          : `Đã quét ${externalSyncJob.scannedCount} bài`,
      counts: {
        scanned: externalSyncJob.scannedCount,
        imported: externalSyncJob.importedCount,
        updated: externalSyncJob.updatedCount,
        skipped: externalSyncJob.skippedCount,
        failed: externalSyncJob.failedCount,
      },
    };
  }
  if (job.status === 'RUNNING' || job.status === 'QUEUED') {
    const staleQueued = isStaleQueued(job);
    return {
      mode: 'INDETERMINATE',
      current: 0,
      total: null,
      percent: null,
      label: staleQueued
        ? 'Job chờ quá lâu; có thể là record cũ không còn trong Redis'
        : job.status === 'QUEUED'
          ? 'Đang chờ worker nhận job'
          : 'Worker đang xử lý',
    };
  }
  return null;
}

function compareJobsForActivity(left: BackgroundJob, right: BackgroundJob): number {
  const rankDelta = scoreJob(right) - scoreJob(left);
  if (rankDelta !== 0) return rankDelta;
  return right.updatedAt.getTime() - left.updatedAt.getTime();
}

function scoreJob(job: BackgroundJob): number {
  if (isStaleQueued(job)) return 1;
  const status = job.status;
  switch (status) {
    case 'RUNNING':
      return 6;
    case 'QUEUED':
      return 5;
    case 'FAILED':
      return 4;
    case 'DEAD':
      return 3;
    case 'COMPLETED':
      return 2;
  }
}

function isActiveJob(job: BackgroundJob): boolean {
  return job.status === 'RUNNING' || (job.status === 'QUEUED' && !isStaleQueued(job));
}

function isStaleQueued(job: BackgroundJob): boolean {
  return job.status === 'QUEUED' && Date.now() - job.updatedAt.getTime() > STALE_QUEUED_AFTER_MS;
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
    case 'sync-external-posts':
      return 'Kéo bài ngoại lai';
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

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function platformLabel(platform: Platform): string {
  return platform
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
