import { z } from 'zod';

/**
 * Nguồn gốc của một con số — prompt §5 Module 8 yêu cầu phân biệt rõ bốn nhóm.
 *
 * Đây không phải chi tiết trang trí. Nó tồn tại để ngăn lỗi phân tích nghiêm
 * trọng nhất của loại công cụ này: hiển thị `0` cho dữ liệu mà nền tảng không
 * cung cấp, hoặc cho dữ liệu chưa kịp đồng bộ. Người dùng sẽ đọc số 0 đó như
 * "bài đăng không có tương tác" và ra quyết định sai.
 */
export const METRIC_SOURCES = ['PLATFORM_API', 'DERIVED', 'UNSUPPORTED', 'NOT_SYNCED'] as const;

export type MetricSource = (typeof METRIC_SOURCES)[number];
export const metricSourceSchema = z.enum(METRIC_SOURCES);

/**
 * Một chỉ số luôn đi kèm nguồn gốc của nó.
 *
 * `value === null` là hợp lệ và có ý nghĩa: "không có số", khác hoàn toàn với 0.
 */
export interface MetricValue {
  value: number | null;
  source: MetricSource;
}

export const metricValueSchema = z.object({
  value: z.number().nullable(),
  source: metricSourceSchema,
});

export const PLATFORM_METRIC_UNITS = [
  'count',
  'percent',
  'ratio',
  'seconds',
  'minutes',
  'milliseconds',
  'text',
] as const;

export type PlatformMetricUnit = (typeof PLATFORM_METRIC_UNITS)[number];
export type PlatformMetricPrimitive = number | string | boolean | null;

export interface PlatformMetricValue {
  key: string;
  label: string;
  value: PlatformMetricPrimitive;
  unit?: PlatformMetricUnit;
  group?: string;
  source?: MetricSource;
  description?: string;
}

export type PlatformMetricMap = Record<string, PlatformMetricValue>;

export function metricFromApi(value: number): MetricValue {
  return { value, source: 'PLATFORM_API' };
}

export function derivedMetric(value: number | null): MetricValue {
  return { value, source: 'DERIVED' };
}

export const UNSUPPORTED_METRIC: MetricValue = { value: null, source: 'UNSUPPORTED' };
export const NOT_SYNCED_METRIC: MetricValue = { value: null, source: 'NOT_SYNCED' };

/**
 * Chỉ những metric có số thật mới được đưa vào phép cộng.
 * Trả `null` khi không có giá trị nào hợp lệ — KHÔNG trả 0.
 */
export function sumMetrics(values: readonly MetricValue[]): MetricValue {
  const usable = values.filter(
    (m): m is MetricValue & { value: number } =>
      m.value !== null && (m.source === 'PLATFORM_API' || m.source === 'DERIVED'),
  );
  if (usable.length === 0) return { value: null, source: 'NOT_SYNCED' };
  return { value: usable.reduce((acc, m) => acc + m.value, 0), source: 'DERIVED' };
}

/**
 * Định dạng để hiển thị. Đây là nơi luật "không bao giờ hiện 0 cho dữ liệu
 * thiếu" được thi hành một lần cho toàn hệ thống.
 */
export function formatMetricForDisplay(metric: MetricValue): string {
  if (metric.value === null) return '—';
  return metric.value.toLocaleString('en-US');
}

export interface PostMetrics {
  views: MetricValue;
  likes: MetricValue;
  comments: MetricValue;
  shares: MetricValue;
  reach: MetricValue;
  impressions: MetricValue;
  saves: MetricValue;
  engagement: MetricValue;
  engagementRate: MetricValue;
  watchTime: MetricValue;
  avgWatchTime: MetricValue;
  completionRate: MetricValue;
  clicks: MetricValue;
  linkClicks: MetricValue;
  raw?: Record<string, unknown>;
}

export interface AccountMetrics {
  followers: MetricValue;
  followersGained: MetricValue;
  reach: MetricValue;
  impressions: MetricValue;
  profileViews: MetricValue;
  raw?: Record<string, unknown>;
}

export function emptyPostMetrics(source: MetricSource = 'NOT_SYNCED'): PostMetrics {
  const blank: MetricValue = { value: null, source };
  return {
    views: { ...blank },
    likes: { ...blank },
    comments: { ...blank },
    shares: { ...blank },
    reach: { ...blank },
    impressions: { ...blank },
    saves: { ...blank },
    engagement: { ...blank },
    engagementRate: { ...blank },
    watchTime: { ...blank },
    avgWatchTime: { ...blank },
    completionRate: { ...blank },
    clicks: { ...blank },
    linkClicks: { ...blank },
  };
}

/**
 * Engagement rate = (like + comment + share + save) / reach.
 *
 * Chỉ tính khi CÓ ĐỦ dữ liệu thật. Thiếu mẫu số hoặc mẫu số bằng 0 → trả về
 * `NOT_SYNCED`, không trả 0. Một tỉ lệ 0% và một tỉ lệ "chưa biết" là hai điều
 * hoàn toàn khác nhau đối với người đọc dashboard.
 */
export function computeEngagementRate(metrics: PostMetrics): MetricValue {
  const parts = [metrics.likes, metrics.comments, metrics.shares, metrics.saves];
  const usable = parts.filter(
    (m): m is MetricValue & { value: number } => m.value !== null && m.source === 'PLATFORM_API',
  );
  if (usable.length === 0) return { value: null, source: 'NOT_SYNCED' };

  const denominator = metrics.reach.value ?? metrics.impressions.value;
  if (denominator === null || denominator <= 0) return { value: null, source: 'NOT_SYNCED' };

  const interactions = usable.reduce((acc, m) => acc + m.value, 0);
  return { value: (interactions / denominator) * 100, source: 'DERIVED' };
}
