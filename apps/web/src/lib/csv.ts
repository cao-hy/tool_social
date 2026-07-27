export type CsvRow = Record<string, string | number | boolean | null | undefined>;

export function rowsToCsv(rows: CsvRow[], headers: string[]): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvCell(row[header])).join(','));
  }
  return lines.join('\r\n');
}

export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const injectionSafe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${injectionSafe.replace(/"/g, '""')}"`;
}
