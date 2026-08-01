import type { Platform } from '@socialhub/shared';
import type { PlatformPostView } from '@/lib/types';

export type MetricKey =
  | 'views'
  | 'reach'
  | 'impressions'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'saves'
  | 'engagement'
  | 'engagementRate';

export interface MetricValueView {
  value: number | null;
  source: string;
}

export interface NormalizedPostMetrics {
  values: Partial<Record<MetricKey, MetricValueView>>;
  refreshedAt: string | null;
  error: string | null;
}

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  hint: string;
  percent?: boolean;
}

const COMMON_METRIC_DEFINITIONS: MetricDefinition[] = [
  { key: 'views', label: 'Views', hint: 'Lượt xem video/post nếu nền tảng có trả về.' },
  { key: 'reach', label: 'Reach', hint: 'Số tài khoản duy nhất đã tiếp cận.' },
  { key: 'impressions', label: 'Impressions', hint: 'Tổng số lần nội dung được hiển thị.' },
  { key: 'likes', label: 'Likes', hint: 'Like/reaction nền tảng trả về.' },
  { key: 'comments', label: 'Comments', hint: 'Số bình luận nền tảng trả về.' },
  { key: 'shares', label: 'Shares', hint: 'Lượt chia sẻ.' },
  { key: 'saves', label: 'Saves', hint: 'Lượt lưu/pin save.' },
  { key: 'engagement', label: 'Engagement', hint: 'Tổng tương tác có thể đọc được.' },
  {
    key: 'engagementRate',
    label: 'Eng. rate',
    hint: 'Tương tác / reach hoặc impressions.',
    percent: true,
  },
];

const PLATFORM_METRIC_ORDER: Record<Platform, MetricKey[]> = {
  FACEBOOK: ['impressions', 'reach', 'likes', 'comments', 'shares', 'engagement'],
  INSTAGRAM: [
    'views',
    'reach',
    'impressions',
    'likes',
    'comments',
    'shares',
    'saves',
    'engagement',
    'engagementRate',
  ],
  PINTEREST: ['impressions', 'views', 'saves', 'likes', 'comments', 'engagement', 'engagementRate'],
  YOUTUBE: ['views', 'likes', 'comments', 'engagement'],
  TIKTOK: ['views', 'likes', 'comments', 'shares', 'engagement', 'engagementRate'],
};

export function metricDefinitionsForPlatform(platform: Platform): MetricDefinition[] {
  const byKey = new Map(COMMON_METRIC_DEFINITIONS.map((item) => [item.key, item]));
  return PLATFORM_METRIC_ORDER[platform].map((key) => byKey.get(key)).filter(isMetricDefinition);
}

export function extractPlatformPostMetrics(platformPost: PlatformPostView): NormalizedPostMetrics {
  const state = asRecord(platformPost.platformState);
  const metrics = asRecord(state?.metrics);
  const values: NormalizedPostMetrics['values'] = {};

  for (const definition of COMMON_METRIC_DEFINITIONS) {
    const metric =
      readMetricValue(metrics, definition.key) ?? readLegacyMetric(state, definition.key);
    if (metric) values[definition.key] = metric;
  }

  return {
    values,
    refreshedAt: readString(state?.metricsRefreshedAt) ?? readString(state?.refreshedAt),
    error: readMetricsError(state),
  };
}

export function aggregatePlatformMetrics(platformPosts: PlatformPostView[]): NormalizedPostMetrics {
  const aggregate: NormalizedPostMetrics = {
    values: {},
    refreshedAt: null,
    error: null,
  };

  for (const platformPost of platformPosts) {
    const metrics = extractPlatformPostMetrics(platformPost);
    if (
      metrics.refreshedAt &&
      (!aggregate.refreshedAt || metrics.refreshedAt > aggregate.refreshedAt)
    ) {
      aggregate.refreshedAt = metrics.refreshedAt;
    }
    for (const key of Object.keys(metrics.values) as MetricKey[]) {
      const current = metrics.values[key];
      if (!current || current.value === null) continue;
      const previous = aggregate.values[key];
      aggregate.values[key] = {
        value: (previous?.value ?? 0) + current.value,
        source: 'DERIVED',
      };
    }
  }

  return aggregate;
}

export function hasVisibleMetrics(metrics: NormalizedPostMetrics): boolean {
  return Object.values(metrics.values).some((item) => item?.value !== null);
}

export function metricSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'PLATFORM_API':
      return 'API';
    case 'DERIVED':
      return 'Tính toán';
    case 'UNSUPPORTED':
      return 'Không hỗ trợ';
    case 'NOT_SYNCED':
      return 'Chưa sync';
    default:
      return source ?? 'Không rõ';
  }
}

export function formatMetricNumber(value: number | null | undefined, percent = false): string {
  if (value === null || value === undefined) return '-';
  if (percent) {
    return `${value.toLocaleString('en-US', {
      maximumFractionDigits: 2,
      minimumFractionDigits: value > 0 && value < 1 ? 2 : 0,
    })}%`;
  }
  return value.toLocaleString('en-US');
}

function readMetricValue(record: Record<string, unknown> | undefined, key: MetricKey) {
  const raw = record?.[key];
  if (typeof raw === 'number') return { value: raw, source: 'PLATFORM_API' };
  const metric = asRecord(raw);
  if (!metric) return null;
  const value = readNumber(metric.value);
  const source = readString(metric.source) ?? 'PLATFORM_API';
  return { value, source };
}

function readLegacyMetric(
  state: Record<string, unknown> | undefined,
  key: MetricKey,
): MetricValueView | null {
  const legacyKeys: Record<MetricKey, string[]> = {
    views: ['views', 'viewCount', 'view_count', 'videoViews', 'video_views', 'playCount'],
    reach: ['reach'],
    impressions: ['impressions', 'impressionCount'],
    likes: ['likes', 'likeCount', 'like_count'],
    comments: ['comments', 'commentCount', 'comment_count'],
    shares: ['shares', 'shareCount', 'share_count'],
    saves: ['saves', 'saveCount', 'saved', 'favoriteCount'],
    engagement: ['engagement', 'engagementCount'],
    engagementRate: ['engagementRate'],
  };

  for (const legacyKey of legacyKeys[key]) {
    const value = readNumber(state?.[legacyKey]);
    if (value !== null) return { value, source: 'PLATFORM_API' };
  }

  const statistics = asRecord(state?.statistics);
  for (const legacyKey of legacyKeys[key]) {
    const value = readNumber(statistics?.[legacyKey]);
    if (value !== null) return { value, source: 'PLATFORM_API' };
  }
  return null;
}

function readMetricsError(state: Record<string, unknown> | undefined): string | null {
  const error = asRecord(state?.metricsError);
  return readString(error?.message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isMetricDefinition(value: MetricDefinition | undefined): value is MetricDefinition {
  return Boolean(value);
}
