/**
 * Local calendar days for patient-facing dates.
 *
 * The API must never invent "today" from its own clock in UTC: for a patient
 * in New York the UTC date flips to tomorrow at 8 PM, so an evening check-in
 * or food log would land on a day the patient hasn't reached yet. When a
 * request doesn't carry the app's local day, derive it from the patient's
 * stored IANA timezone; UTC remains the documented last resort for accounts
 * that haven't recorded a timezone yet (profile setup not completed).
 */

/** YYYY-MM-DD at `at` in the given IANA timezone; UTC when unusable. */
export function dayKeyInTimeZone(
  timeZone: string | null | undefined,
  at: Date = new Date(),
): string {
  if (typeof timeZone === "string" && timeZone.trim().length > 0) {
    try {
      // en-CA formats dates exactly as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(at);
    } catch {
      // Unknown or malformed zone name: fall through to UTC.
    }
  }
  return at.toISOString().slice(0, 10);
}

/**
 * The latest day key a real device could honestly call "today": the current
 * calendar day in the world's fastest timezone (UTC+14) plus one more day of
 * clock-skew allowance. Later keys can only come from a badly wrong clock or
 * fabricated input — accepting them would strand rows on days the patient
 * won't see for years. There is no matching floor here: browsing and
 * deliberate backfill to past days are legitimate.
 */
export function maxPlausibleDayKey(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + (14 + 24) * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
