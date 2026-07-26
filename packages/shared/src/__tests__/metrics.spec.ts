import { describe, expect, it } from 'vitest';
import {
  computeEngagementRate,
  emptyPostMetrics,
  formatMetricForDisplay,
  metricFromApi,
  NOT_SYNCED_METRIC,
  sumMetrics,
  UNSUPPORTED_METRIC,
} from '../metrics';

describe('formatMetricForDisplay — luật quan trọng nhất của module analytics', () => {
  it('dữ liệu nền tảng KHÔNG hỗ trợ hiển thị "—", không phải 0', () => {
    expect(formatMetricForDisplay(UNSUPPORTED_METRIC)).toBe('—');
  });

  it('dữ liệu CHƯA đồng bộ hiển thị "—", không phải 0', () => {
    expect(formatMetricForDisplay(NOT_SYNCED_METRIC)).toBe('—');
  });

  it('số 0 thật từ API vẫn hiển thị là 0', () => {
    expect(formatMetricForDisplay(metricFromApi(0))).toBe('0');
  });

  it('số thật được format có phân cách nghìn', () => {
    expect(formatMetricForDisplay(metricFromApi(1234567))).toBe('1,234,567');
  });
});

describe('sumMetrics', () => {
  it('bỏ qua metric không hỗ trợ và chưa đồng bộ', () => {
    const result = sumMetrics([metricFromApi(10), UNSUPPORTED_METRIC, metricFromApi(5)]);
    expect(result.value).toBe(15);
    expect(result.source).toBe('DERIVED');
  });

  it('không có metric hợp lệ nào → null, KHÔNG phải 0', () => {
    const result = sumMetrics([UNSUPPORTED_METRIC, NOT_SYNCED_METRIC]);
    expect(result.value).toBeNull();
    expect(result.source).toBe('NOT_SYNCED');
  });

  it('mảng rỗng → null', () => {
    expect(sumMetrics([]).value).toBeNull();
  });
});

describe('computeEngagementRate', () => {
  it('tính đúng khi có đủ dữ liệu thật', () => {
    const metrics = emptyPostMetrics();
    metrics.likes = metricFromApi(50);
    metrics.comments = metricFromApi(30);
    metrics.shares = metricFromApi(20);
    metrics.saves = metricFromApi(0);
    metrics.reach = metricFromApi(1000);

    const rate = computeEngagementRate(metrics);
    expect(rate.value).toBeCloseTo(10);
    expect(rate.source).toBe('DERIVED');
  });

  it('dùng impressions làm mẫu số khi không có reach', () => {
    const metrics = emptyPostMetrics();
    metrics.likes = metricFromApi(10);
    metrics.impressions = metricFromApi(200);

    expect(computeEngagementRate(metrics).value).toBeCloseTo(5);
  });

  it('thiếu mẫu số → NOT_SYNCED, KHÔNG trả 0%', () => {
    const metrics = emptyPostMetrics();
    metrics.likes = metricFromApi(10);

    const rate = computeEngagementRate(metrics);
    expect(rate.value).toBeNull();
    expect(rate.source).toBe('NOT_SYNCED');
  });

  it('mẫu số bằng 0 → NOT_SYNCED, không chia cho 0', () => {
    const metrics = emptyPostMetrics();
    metrics.likes = metricFromApi(10);
    metrics.reach = metricFromApi(0);

    expect(computeEngagementRate(metrics).value).toBeNull();
  });

  it('không có tương tác nào được API trả về → NOT_SYNCED', () => {
    const metrics = emptyPostMetrics();
    metrics.reach = metricFromApi(1000);

    expect(computeEngagementRate(metrics).source).toBe('NOT_SYNCED');
  });
});

describe('emptyPostMetrics', () => {
  it('mặc định mọi chỉ số là NOT_SYNCED với value null', () => {
    const metrics = emptyPostMetrics();
    for (const metric of Object.values(metrics)) {
      expect(metric.value).toBeNull();
      expect(metric.source).toBe('NOT_SYNCED');
    }
  });
});
