import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma } from '@socialhub/db';
import {
  buildJobId,
  buildQueueJobOptions,
  formatMetricForDisplay,
  type MetricSource,
  type MetricValue,
  type Platform,
  type PlatformMetricValue,
  type QueueName,
  type QueuePayload,
} from '@socialhub/shared';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import type { AnalyticsQuery, SyncAnalyticsInput } from './analytics.schemas';

type MetricKey =
  | 'views'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'reach'
  | 'impressions'
  | 'saves'
  | 'engagementRate'
  | 'watchTime'
  | 'avgWatchTime'
  | 'completionRate'
  | 'clicks'
  | 'linkClicks';

const METRIC_KEYS: MetricKey[] = [
  'views',
  'likes',
  'comments',
  'shares',
  'reach',
  'impressions',
  'saves',
  'engagementRate',
  'watchTime',
  'avgWatchTime',
  'completionRate',
  'clicks',
  'linkClicks',
];

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly postMetricsQueue: Queue;
  private readonly accountMetricsQueue: Queue;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    this.postMetricsQueue = new Queue('sync-post-metrics', { connection: this.redis.getClient() });
    this.accountMetricsQueue = new Queue('sync-account-metrics', {
      connection: this.redis.getClient(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.postMetricsQueue.close(), this.accountMetricsQueue.close()]);
  }

  async dashboard(workspaceId: string, query: AnalyticsQuery) {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    const range = resolveDateRange(query, workspace.timezone);
    const platformPostWhere = platformPostFilter(workspaceId, query);

    const [platformPosts, snapshots, accountSnapshots] = await Promise.all([
      this.prisma.platformPost.findMany({
        where: {
          ...platformPostWhere,
          status: 'PUBLISHED',
          externalPostId: { not: null },
        },
        include: {
          contentPost: { select: { id: true, title: true, body: true, publishedAt: true } },
          socialAccount: { select: { id: true, platform: true, name: true, username: true } },
          metric: true,
          metricSnapshots: {
            orderBy: { capturedAt: 'desc' },
            take: 1,
            select: { raw: true, capturedAt: true },
          },
        },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      }),
      this.prisma.metricSnapshot.findMany({
        where: {
          workspaceId,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          platformPost: platformPostWhere,
        },
        include: {
          platformPost: {
            select: {
              id: true,
              platform: true,
              socialAccountId: true,
              socialAccount: { select: { name: true } },
            },
          },
        },
        orderBy: [{ metricDate: 'asc' }, { capturedAt: 'asc' }],
      }),
      this.prisma.metricSnapshot.findMany({
        where: {
          workspaceId,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          socialAccountId: { not: null },
          socialAccount: socialAccountFilter(workspaceId, query),
        },
        include: {
          socialAccount: {
            select: { id: true, platform: true, name: true, username: true },
          },
        },
        orderBy: [{ metricDate: 'asc' }, { capturedAt: 'asc' }],
      }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      range: { from: range.from, to: range.to, timezone: workspace.timezone },
      summary: summarize(platformPosts),
      byPlatform: buildPlatformBreakdown(platformPosts),
      timeSeries: buildTimeSeries(snapshots),
      posts: buildAllPosts(platformPosts),
      followerGrowth: buildFollowerGrowth(accountSnapshots),
    };
  }

  async enqueueSync(workspaceId: string, input: SyncAnalyticsInput) {
    const syncRunId = randomUUID();
    const targetIds = input.platformPostIds?.length
      ? input.platformPostIds
      : (
          await this.prisma.platformPost.findMany({
            where: {
              ...platformPostFilter(workspaceId, input),
              status: 'PUBLISHED',
              externalPostId: { not: null },
            },
            select: { id: true },
            orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
            take: 50,
          })
        ).map((item) => item.id);

    let postMetricsQueued = 0;
    const jobs: Array<{
      id: string;
      queueName: QueueName;
      jobId: string;
      label: string;
    }> = [];
    for (const platformPostId of targetIds) {
      const payload: QueuePayload<'sync-post-metrics'> = {
        platformPostId,
        workspaceId,
        syncRunId,
      };
      const jobId = buildJobId('sync-post-metrics', payload);
      const record = await this.ensureQueuedBackgroundJob('sync-post-metrics', jobId, payload);
      const opts = buildQueueJobOptions('sync-post-metrics', jobId);
      await this.postMetricsQueue.add('sync-post-metrics', payload, opts);
      jobs.push({
        id: record.id,
        queueName: 'sync-post-metrics',
        jobId,
        label: 'Đồng bộ metric bài',
      });
      postMetricsQueued += 1;
    }

    const accountIds = (
      await this.prisma.socialAccount.findMany({
        where: {
          ...socialAccountFilter(workspaceId, input),
          status: 'CONNECTED',
        },
        select: { id: true },
        take: 50,
      })
    ).map((account) => account.id);

    let accountMetricsQueued = 0;
    for (const socialAccountId of accountIds) {
      const payload: QueuePayload<'sync-account-metrics'> = {
        socialAccountId,
        workspaceId,
        syncRunId,
      };
      const jobId = buildJobId('sync-account-metrics', payload);
      const record = await this.ensureQueuedBackgroundJob('sync-account-metrics', jobId, payload);
      const opts = buildQueueJobOptions('sync-account-metrics', jobId);
      await this.accountMetricsQueue.add('sync-account-metrics', payload, opts);
      jobs.push({
        id: record.id,
        queueName: 'sync-account-metrics',
        jobId,
        label: 'Đồng bộ metric tài khoản',
      });
      accountMetricsQueued += 1;
    }

    return {
      queued: postMetricsQueued + accountMetricsQueued,
      postMetricsQueued,
      accountMetricsQueued,
      jobs,
      syncRunId,
    };
  }

  private ensureQueuedBackgroundJob<Q extends 'sync-post-metrics' | 'sync-account-metrics'>(
    queueName: Q,
    jobId: string,
    payload: QueuePayload<Q>,
  ) {
    const opts = buildQueueJobOptions(queueName, jobId);
    return this.prisma.backgroundJob.upsert({
      where: { queueName_jobId: { queueName, jobId } },
      create: {
        workspaceId: payload.workspaceId,
        queueName,
        jobId,
        status: 'QUEUED',
        payload: payload as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: opts.attempts,
        correlationId: jobId,
      },
      update: {
        workspaceId: payload.workspaceId,
        status: 'QUEUED',
        payload: payload as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: opts.attempts,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        isDead: false,
        correlationId: jobId,
      },
    });
  }
}

function platformPostFilter(
  workspaceId: string,
  query: { platform?: Platform; socialAccountId?: string },
): Prisma.PlatformPostWhereInput {
  return {
    workspaceId,
    platform: query.platform,
    socialAccountId: query.socialAccountId,
  };
}

function socialAccountFilter(
  workspaceId: string,
  query: { platform?: Platform; socialAccountId?: string },
): Prisma.SocialAccountWhereInput {
  return {
    workspaceId,
    platform: query.platform,
    id: query.socialAccountId,
    deletedAt: null,
  };
}

function summarize(
  platformPosts: Array<{
    metric: {
      lastSyncedAt: Date | null;
      viewsSource: MetricSource;
      likesSource: MetricSource;
      commentsSource: MetricSource;
      sharesSource: MetricSource;
      reachSource: MetricSource;
      impressionsSource: MetricSource;
      savesSource: MetricSource;
      engagementRateSource: MetricSource;
    } | null;
  }>,
) {
  let syncedTargets = 0;
  let unsupportedTargets = 0;
  let notSyncedTargets = 0;

  for (const post of platformPosts) {
    if (!post.metric?.lastSyncedAt) {
      notSyncedTargets += 1;
      continue;
    }
    syncedTargets += 1;
    const sources = metricSources(post.metric);
    if (sources.length > 0 && sources.every((source) => source === 'UNSUPPORTED')) {
      unsupportedTargets += 1;
    }
  }

  return {
    publishedTargets: platformPosts.length,
    syncedTargets,
    notSyncedTargets,
    unsupportedTargets,
  };
}

function buildPlatformBreakdown(
  platformPosts: Array<{
    platform: Platform;
    metric: MetricRecord | null;
    metricSnapshots?: Array<{ raw: Prisma.JsonValue | null }>;
  }>,
) {
  const map = new Map<
    Platform,
    {
      platform: Platform;
      targets: number;
      syncedTargets: number;
      metrics: MetricBag;
      platformMetrics: PlatformMetricView[];
    }
  >();
  const platformMetricMap = new Map<Platform, Map<string, PlatformMetricView>>();
  for (const post of platformPosts) {
    const current =
      map.get(post.platform) ??
      ({
        platform: post.platform,
        targets: 0,
        syncedTargets: 0,
        metrics: emptyMetricBag(),
        platformMetrics: [],
      } satisfies {
        platform: Platform;
        targets: number;
        syncedTargets: number;
        metrics: MetricBag;
        platformMetrics: PlatformMetricView[];
      });
    current.targets += 1;
    if (post.metric?.lastSyncedAt) current.syncedTargets += 1;
    current.metrics = mergeMetricBags(current.metrics, metricsFromPostMetric(post.metric));
    const extracted = extractPlatformMetrics(post.metricSnapshots?.[0]?.raw);
    if (extracted.length > 0) {
      const bucket = platformMetricMap.get(post.platform) ?? new Map<string, PlatformMetricView>();
      for (const metric of extracted) {
        const existing = bucket.get(metric.key);
        bucket.set(metric.key, mergePlatformMetric(existing, metric));
      }
      platformMetricMap.set(post.platform, bucket);
    }
    map.set(post.platform, current);
  }
  for (const item of map.values()) {
    item.platformMetrics = [...(platformMetricMap.get(item.platform)?.values() ?? [])].sort(
      comparePlatformMetrics,
    );
  }
  return [...map.values()].sort((left, right) => left.platform.localeCompare(right.platform));
}

function buildTimeSeries(
  snapshots: Array<{
    metricDate: Date;
    platformPost: { platform: Platform } | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    reach: number | null;
    impressions: number | null;
    saves: number | null;
    source: MetricSource;
  }>,
) {
  const map = new Map<string, { date: string; platform: Platform; metrics: MetricBag }>();
  for (const snapshot of snapshots) {
    if (!snapshot.platformPost) continue;
    const date = snapshot.metricDate.toISOString().slice(0, 10);
    const key = `${date}:${snapshot.platformPost.platform}`;
    const current =
      map.get(key) ??
      ({
        date,
        platform: snapshot.platformPost.platform,
        metrics: emptyMetricBag(),
      } satisfies { date: string; platform: Platform; metrics: MetricBag });
    current.metrics = mergeMetricBags(current.metrics, metricsFromSnapshot(snapshot));
    map.set(key, current);
  }
  return [...map.values()].sort((left, right) =>
    left.date === right.date
      ? left.platform.localeCompare(right.platform)
      : left.date.localeCompare(right.date),
  );
}

function buildFollowerGrowth(
  snapshots: Array<{
    metricDate: Date;
    followers: number | null;
    source: MetricSource;
    socialAccount: {
      id: string;
      platform: Platform;
      name: string;
      username: string | null;
    } | null;
  }>,
) {
  const grouped = new Map<
    string,
    {
      socialAccountId: string;
      platform: Platform;
      accountName: string;
      username: string | null;
      snapshots: Array<{ date: string; followers: number | null; source: MetricSource }>;
    }
  >();

  for (const snapshot of snapshots) {
    if (!snapshot.socialAccount) continue;
    const date = snapshot.metricDate.toISOString().slice(0, 10);
    const current =
      grouped.get(snapshot.socialAccount.id) ??
      ({
        socialAccountId: snapshot.socialAccount.id,
        platform: snapshot.socialAccount.platform,
        accountName: snapshot.socialAccount.name,
        username: snapshot.socialAccount.username,
        snapshots: [],
      } satisfies {
        socialAccountId: string;
        platform: Platform;
        accountName: string;
        username: string | null;
        snapshots: Array<{ date: string; followers: number | null; source: MetricSource }>;
      });
    current.snapshots.push({ date, followers: snapshot.followers, source: snapshot.source });
    grouped.set(snapshot.socialAccount.id, current);
  }

  return [...grouped.values()]
    .map(({ snapshots: accountSnapshots, ...account }) => {
      accountSnapshots.sort((left, right) => left.date.localeCompare(right.date));
      const first = accountSnapshots.find(hasFollowerValue);
      const last = [...accountSnapshots].reverse().find(hasFollowerValue);
      const fallbackSource =
        accountSnapshots.length > 0 &&
        accountSnapshots.every((snapshot) => snapshot.source === 'UNSUPPORTED')
          ? 'UNSUPPORTED'
          : 'NOT_SYNCED';
      const source = last?.source ?? fallbackSource;
      const followers: MetricValue = { value: last?.followers ?? null, source };
      const followersGained: MetricValue =
        first && last
          ? { value: last.followers - first.followers, source: 'DERIVED' }
          : { value: null, source };

      return {
        ...account,
        followers,
        followersGained,
        firstDate: first?.date ?? null,
        lastDate: last?.date ?? null,
      };
    })
    .sort((left, right) =>
      left.platform === right.platform
        ? left.accountName.localeCompare(right.accountName)
        : left.platform.localeCompare(right.platform),
    );
}

function hasFollowerValue(snapshot: {
  date: string;
  followers: number | null;
  source: MetricSource;
}): snapshot is { date: string; followers: number; source: MetricSource } {
  return snapshot.followers !== null;
}

function buildAllPosts(
  platformPosts: Array<{
    id: string;
    platform: Platform;
    externalUrl: string | null;
    publishedAt: Date | null;
    contentPost: { id: string; title: string | null; body: string | null };
    socialAccount: { name: string };
    metric: MetricRecord | null;
    metricSnapshots?: Array<{ raw: Prisma.JsonValue | null; capturedAt: Date }>;
  }>,
) {
  return platformPosts
    .map((post) => {
      const metrics = metricsFromPostMetric(post.metric);
      const score = metrics.engagement.value ?? metrics.views.value ?? metrics.impressions.value;
      return {
        id: post.id,
        postId: post.contentPost.id,
        platform: post.platform,
        accountName: post.socialAccount.name,
        title: post.contentPost.title ?? firstLine(post.contentPost.body) ?? '(Không có tiêu đề)',
        externalUrl: post.externalUrl,
        publishedAt: post.publishedAt?.toISOString() ?? null,
        metrics,
        platformMetrics: extractPlatformMetrics(post.metricSnapshots?.[0]?.raw),
        platformMetricsCapturedAt: post.metricSnapshots?.[0]?.capturedAt.toISOString() ?? null,
        score,
      };
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .map(({ score: _score, ...post }) => post);
}

type PlatformMetricView = {
  key: string;
  label: string;
  value: PlatformMetricValue['value'];
  unit?: PlatformMetricValue['unit'];
  group?: string;
  source?: MetricSource;
  description?: string;
};

function extractPlatformMetrics(raw: Prisma.JsonValue | null | undefined): PlatformMetricView[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const platformMetrics = (raw as Record<string, unknown>).platformMetrics;
  if (!platformMetrics || typeof platformMetrics !== 'object' || Array.isArray(platformMetrics)) {
    return [];
  }
  return Object.entries(platformMetrics)
    .flatMap(([fallbackKey, value]) => normalizePlatformMetric(fallbackKey, value))
    .sort(comparePlatformMetrics);
}

function normalizePlatformMetric(fallbackKey: string, value: unknown): PlatformMetricView[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const metricValue = record.value;
  if (!isPlatformMetricPrimitive(metricValue)) return [];
  return [
    {
      key: typeof record.key === 'string' ? record.key : fallbackKey,
      label:
        typeof record.label === 'string'
          ? record.label
          : fallbackKey
              .split(/[_-]/)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join(' '),
      value: metricValue,
      unit: readPlatformMetricUnit(record.unit),
      group: typeof record.group === 'string' ? record.group : undefined,
      source: readMetricSource(record.source),
      description: typeof record.description === 'string' ? record.description : undefined,
    },
  ];
}

function mergePlatformMetric(
  left: PlatformMetricView | undefined,
  right: PlatformMetricView,
): PlatformMetricView {
  if (!left) return right;
  if (typeof left.value === 'number' && typeof right.value === 'number') {
    return { ...left, value: left.value + right.value, source: 'DERIVED' };
  }
  return left.value === null ? right : left;
}

function comparePlatformMetrics(left: PlatformMetricView, right: PlatformMetricView): number {
  const group = (left.group ?? '').localeCompare(right.group ?? '');
  return group === 0 ? left.label.localeCompare(right.label) : group;
}

function isPlatformMetricPrimitive(value: unknown): value is PlatformMetricValue['value'] {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  );
}

function readPlatformMetricUnit(value: unknown): PlatformMetricView['unit'] {
  const allowed = ['count', 'percent', 'ratio', 'seconds', 'minutes', 'milliseconds', 'text'];
  return typeof value === 'string' && allowed.includes(value)
    ? (value as PlatformMetricView['unit'])
    : undefined;
}

function readMetricSource(value: unknown): MetricSource | undefined {
  const allowed: MetricSource[] = ['PLATFORM_API', 'DERIVED', 'UNSUPPORTED', 'NOT_SYNCED'];
  return typeof value === 'string' && allowed.includes(value as MetricSource)
    ? (value as MetricSource)
    : undefined;
}

type MetricRecord = {
  views: number | null;
  viewsSource: MetricSource;
  likes: number | null;
  likesSource: MetricSource;
  comments: number | null;
  commentsSource: MetricSource;
  shares: number | null;
  sharesSource: MetricSource;
  reach: number | null;
  reachSource: MetricSource;
  impressions: number | null;
  impressionsSource: MetricSource;
  saves: number | null;
  savesSource: MetricSource;
  engagementRate: number | null;
  engagementRateSource: MetricSource;
  watchTime: number | null;
  watchTimeSource: MetricSource;
  avgWatchTime: number | null;
  avgWatchTimeSource: MetricSource;
  completionRate: number | null;
  completionRateSource: MetricSource;
  clicks: number | null;
  clicksSource: MetricSource;
  linkClicks: number | null;
  linkClicksSource: MetricSource;
  lastSyncedAt: Date | null;
};

type MetricBag = Record<MetricKey | 'engagement', MetricValue>;

function emptyMetricBag(): MetricBag {
  return {
    views: { value: null, source: 'NOT_SYNCED' },
    likes: { value: null, source: 'NOT_SYNCED' },
    comments: { value: null, source: 'NOT_SYNCED' },
    shares: { value: null, source: 'NOT_SYNCED' },
    reach: { value: null, source: 'NOT_SYNCED' },
    impressions: { value: null, source: 'NOT_SYNCED' },
    saves: { value: null, source: 'NOT_SYNCED' },
    engagement: { value: null, source: 'NOT_SYNCED' },
    engagementRate: { value: null, source: 'NOT_SYNCED' },
    watchTime: { value: null, source: 'NOT_SYNCED' },
    avgWatchTime: { value: null, source: 'NOT_SYNCED' },
    completionRate: { value: null, source: 'NOT_SYNCED' },
    clicks: { value: null, source: 'NOT_SYNCED' },
    linkClicks: { value: null, source: 'NOT_SYNCED' },
  };
}

function metricsFromPostMetric(metric: MetricRecord | null): MetricBag {
  if (!metric) return emptyMetricBag();
  const bag: MetricBag = {
    views: { value: metric.views, source: metric.viewsSource },
    likes: { value: metric.likes, source: metric.likesSource },
    comments: { value: metric.comments, source: metric.commentsSource },
    shares: { value: metric.shares, source: metric.sharesSource },
    reach: { value: metric.reach, source: metric.reachSource },
    impressions: { value: metric.impressions, source: metric.impressionsSource },
    saves: { value: metric.saves, source: metric.savesSource },
    engagementRate: { value: metric.engagementRate, source: metric.engagementRateSource },
    watchTime: { value: metric.watchTime, source: metric.watchTimeSource },
    avgWatchTime: { value: metric.avgWatchTime, source: metric.avgWatchTimeSource },
    completionRate: { value: metric.completionRate, source: metric.completionRateSource },
    clicks: { value: metric.clicks, source: metric.clicksSource },
    linkClicks: { value: metric.linkClicks, source: metric.linkClicksSource },
    engagement: { value: null, source: 'NOT_SYNCED' },
  };
  bag.engagement = sumValues([bag.likes, bag.comments, bag.shares, bag.saves]);
  return bag;
}

function metricsFromSnapshot(snapshot: {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reach: number | null;
  impressions: number | null;
  saves: number | null;
  watchTime?: number | null;
  avgWatchTime?: number | null;
  completionRate?: number | null;
  clicks?: number | null;
  linkClicks?: number | null;
  source: MetricSource;
}): MetricBag {
  const metric = (value: number | null): MetricValue => ({
    value,
    source: value === null && snapshot.source !== 'UNSUPPORTED' ? 'NOT_SYNCED' : snapshot.source,
  });
  const bag: MetricBag = {
    views: metric(snapshot.views),
    likes: metric(snapshot.likes),
    comments: metric(snapshot.comments),
    shares: metric(snapshot.shares),
    reach: metric(snapshot.reach),
    impressions: metric(snapshot.impressions),
    saves: metric(snapshot.saves),
    engagementRate: { value: null, source: 'NOT_SYNCED' },
    watchTime: metric(snapshot.watchTime ?? null),
    avgWatchTime: metric(snapshot.avgWatchTime ?? null),
    completionRate: metric(snapshot.completionRate ?? null),
    clicks: metric(snapshot.clicks ?? null),
    linkClicks: metric(snapshot.linkClicks ?? null),
    engagement: { value: null, source: 'NOT_SYNCED' },
  };
  bag.engagement = sumValues([bag.likes, bag.comments, bag.shares, bag.saves]);
  return bag;
}

function mergeMetricBags(left: MetricBag, right: MetricBag): MetricBag {
  const merged = { ...left };
  for (const key of [...METRIC_KEYS, 'engagement'] as const) {
    merged[key] = sumValues([left[key], right[key]]);
  }
  return merged;
}

function sumValues(values: MetricValue[]): MetricValue {
  const usable = values.filter(
    (metric): metric is MetricValue & { value: number } =>
      metric.value !== null && (metric.source === 'PLATFORM_API' || metric.source === 'DERIVED'),
  );
  if (usable.length === 0) {
    const allUnsupported =
      values.length > 0 && values.every((metric) => metric.source === 'UNSUPPORTED');
    return { value: null, source: allUnsupported ? 'UNSUPPORTED' : 'NOT_SYNCED' };
  }
  return {
    value: usable.reduce((sum, metric) => sum + metric.value, 0),
    source: 'DERIVED',
  };
}

function metricSources(metric: NonNullable<Parameters<typeof summarize>[0][number]['metric']>) {
  return METRIC_KEYS.map((key) => metric[`${key}Source` as keyof typeof metric]).filter(
    (value): value is MetricSource => typeof value === 'string',
  );
}

function resolveDateRange(query: AnalyticsQuery, timezone: string) {
  const today = dateKeyInTimezone(new Date(), timezone);
  const from = query.from ?? addDays(today, -30);
  const to = query.to ?? today;
  return {
    from,
    to,
    fromDate: dateFromKey(from),
    toDate: dateFromKey(to),
  };
}

function dateKeyInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function addDays(key: string, days: number): string {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstLine(value: string | null): string | null {
  const line = value?.split(/\r?\n/)[0]?.trim();
  return line || null;
}

export function displayMetric(metric: MetricValue): string {
  return formatMetricForDisplay(metric);
}
