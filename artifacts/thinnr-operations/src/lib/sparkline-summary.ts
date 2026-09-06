/** Accessible one-sentence summary of a sparkline series (React-free for the scripts). */
export function sparklineSummary(values: number[], label: string): string {
  if (values.length === 0) return `No ${label} trend for this range`;
  const first = values[0];
  const last = values[values.length - 1];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const direction = last > first ? 'up' : last < first ? 'down' : 'flat';
  return `${label} trend over ${values.length} days: ${direction}, from ${first} to ${last} (low ${min}, high ${max})`;
}
