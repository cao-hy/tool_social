interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface SchedulePreview {
  utcIso: string;
  workspaceTimezone: string;
  localTimezone: string;
  workspaceText: string;
  localText: string;
  utcText: string;
  relativeText: string;
  isPast: boolean;
}

export function buildSchedulePreview(
  datetimeLocal: string,
  workspaceTimezone: string,
  now = new Date(),
  localTimezone = browserTimezone(),
): SchedulePreview | null {
  if (!datetimeLocal) return null;
  const utcDate = zonedDateTimeLocalToUtc(datetimeLocal, workspaceTimezone);

  return {
    utcIso: utcDate.toISOString(),
    workspaceTimezone,
    localTimezone,
    workspaceText: formatDateTimeInZone(utcDate, workspaceTimezone),
    localText: formatDateTimeInZone(utcDate, localTimezone),
    utcText: utcDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    relativeText: formatRelativeTime(utcDate.getTime() - now.getTime()),
    isPast: utcDate.getTime() <= now.getTime(),
  };
}

export function zonedDateTimeLocalToUtcIso(datetimeLocal: string, timeZone: string): string {
  return zonedDateTimeLocalToUtc(datetimeLocal, timeZone).toISOString();
}

function zonedDateTimeLocalToUtc(datetimeLocal: string, timeZone: string): Date {
  const parts = parseDatetimeLocal(datetimeLocal);
  const wallTimeMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let utcMs = wallTimeMs;
  for (let index = 0; index < 3; index += 1) {
    utcMs = wallTimeMs - getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  }

  return new Date(utcMs);
}

function parseDatetimeLocal(value: string): DateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error('Thời gian lên lịch không đúng định dạng.');

  const [, year, month, day, hour, minute, second = '00'] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const zonedAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtcMs - date.getTime();
}

function getZonedParts(date: Date, timeZone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: requiredPart(values, 'year'),
    month: requiredPart(values, 'month'),
    day: requiredPart(values, 'day'),
    hour: requiredPart(values, 'hour'),
    minute: requiredPart(values, 'minute'),
    second: requiredPart(values, 'second'),
  };
}

function requiredPart(values: Record<string, number>, key: string): number {
  const value = values[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Không đọc được thành phần thời gian: ${key}`);
  }
  return value;
}

function formatDateTimeInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function formatRelativeTime(diffMs: number): string {
  const absMinutes = Math.max(1, Math.round(Math.abs(diffMs) / 60_000));
  const days = Math.floor(absMinutes / 1440);
  const hours = Math.floor((absMinutes % 1440) / 60);
  const minutes = absMinutes % 60;
  const parts = [
    days > 0 ? `${days} ngày` : null,
    hours > 0 ? `${hours} giờ` : null,
    days === 0 && minutes > 0 ? `${minutes} phút` : null,
  ].filter(Boolean);
  return `${diffMs >= 0 ? 'Còn' : 'Đã qua'} ${parts.join(' ')}`;
}
