/** Date-only bloodwork values never pass through Date's UTC parser. */
export function isBloodworkDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const local = new Date(year, month - 1, day, 12);
  return local.getFullYear() === year
    && local.getMonth() === month - 1
    && local.getDate() === day;
}

/** Render a persisted YYYY-MM-DD as MM/DD/YY without a timezone shift. */
export function formatBloodworkDate(value: string | null | undefined): string {
  if (!value || !isBloodworkDateKey(value)) return 'No date';
  const [year, month, day] = value.split('-');
  return `${month}/${day}/${year.slice(-2)}`;
}