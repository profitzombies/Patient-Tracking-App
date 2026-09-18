/**
 * Phone-number matching for roster search.
 *
 * Staff type numbers however they remember them ("555-123-4567",
 * "(555) 123-4567", "+1 555 123 4567") and the stored value may be E.164
 * ("+15551234567") or a formatted display string. Both sides reduce to a
 * digit string with any leading US country code dropped, so a match is a
 * plain digit-substring test; partial digit strings match too.
 */

/** Digits only; an 11-digit string that starts with the US "1" loses it. */
export function phoneDigits(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D+/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * True when the query carries digits and they appear (as a run) in any of the
 * candidate phone values. A query without digits never matches a phone.
 */
export function matchesPhoneQuery(query: string, ...phones: Array<string | null | undefined>): boolean {
  const needle = phoneDigits(query);
  if (!needle) return false;
  const rawNeedle = query.replace(/\D+/g, '');
  return phones.some((phone) => {
    if (!phone) return false;
    const raw = phone.replace(/\D+/g, '');
    return phoneDigits(phone).includes(needle) || raw.includes(rawNeedle);
  });
}
