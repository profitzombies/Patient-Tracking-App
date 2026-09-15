/**
 * Device-local clock helpers for signed-in (live) surfaces.
 *
 * Server timestamps arrive as UTC instants. Anything shown to a signed-in
 * person must be rendered in *their* device timezone — slicing the ISO string
 * (`asOf.split('T')[0]`) reads the UTC calendar day, which is already
 * "tomorrow" for US viewers every evening. The guided demo never uses these:
 * it stays anchored to the fixed synthetic date.
 */

export type TimeOfDayGreeting = 'Good morning' | 'Good afternoon' | 'Good evening';

/** Salutation for the device's local hour: morning 5–11, afternoon 12–16, evening otherwise. */
export function timeOfDayGreeting(now: Date = new Date()): TimeOfDayGreeting {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Format a UTC instant (ISO string or Date) as the device-local calendar date, e.g. "Sep 14, 2026". */
export function formatLocalDate(instant: string | Date, includeYear = true): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return 'Live';
  return date.toLocaleDateString('en-US', includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
}
