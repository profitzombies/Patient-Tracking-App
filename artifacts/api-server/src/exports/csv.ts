/**
 * Minimal RFC 4180 CSV writer with spreadsheet-formula neutralisation.
 *
 * Every cell is quoted when it carries a delimiter, quote, or line break.
 * Cells beginning with `=`, `+`, `-`, `@`, tab, or CR are prefixed with a
 * single quote so a crafted office name or audit metadata value can never
 * execute as a formula when the file is opened in Excel/Sheets.
 */
export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly CsvCell[]): string {
  return cells.map(csvCell).join(",");
}

/** UTF-8 with BOM so Excel opens non-ASCII office names correctly. */
export function csvBuffer(header: readonly string[], rows: readonly (readonly CsvCell[])[]): Buffer {
  const lines = [csvLine(header), ...rows.map((row) => csvLine(row))];
  return Buffer.from(`\ufeff${lines.join("\r\n")}\r\n`, "utf8");
}
