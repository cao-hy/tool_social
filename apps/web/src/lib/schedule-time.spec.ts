import { describe, expect, it } from 'vitest';
import { buildSchedulePreview, zonedDateTimeLocalToUtcIso } from './schedule-time';

describe('schedule-time', () => {
  it('converts Vietnam workspace wall time to UTC', () => {
    expect(zonedDateTimeLocalToUtcIso('2026-08-01T20:00', 'Asia/Ho_Chi_Minh')).toBe(
      '2026-08-01T13:00:00.000Z',
    );
  });

  it('converts US Eastern workspace wall time with DST to UTC', () => {
    expect(zonedDateTimeLocalToUtcIso('2026-08-01T09:00', 'America/New_York')).toBe(
      '2026-08-01T13:00:00.000Z',
    );
  });

  it('builds a preview comparing workspace, local and UTC time', () => {
    const preview = buildSchedulePreview(
      '2026-08-01T09:00',
      'America/New_York',
      new Date('2026-08-01T10:00:00.000Z'),
      'Asia/Ho_Chi_Minh',
    );

    expect(preview?.utcIso).toBe('2026-08-01T13:00:00.000Z');
    expect(preview?.workspaceTimezone).toBe('America/New_York');
    expect(preview?.localTimezone).toBe('Asia/Ho_Chi_Minh');
    expect(preview?.isPast).toBe(false);
    expect(preview?.relativeText).toBe('Còn 3 giờ');
  });
});
