/**
 * Identifier + password rules for the account-claiming flow.
 *
 * Phone normalization follows the data reality of the migrated tables: US
 * numbers stored in assorted formats. We strip non-digits, take the last 10,
 * and prefix +1 — the same rule the database-side candidate lookup applies.
 */

export type NormalizedIdentifier =
  | { kind: "phone"; e164: string; last10: string }
  | { kind: "email"; email: string };

export function normalizeIdentifier(raw: unknown): NormalizedIdentifier | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("@")) {
    const email = value.toLowerCase();
    if (email.length > 320) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { kind: "email", email };
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  const last10 = digits.slice(-10);
  return { kind: "phone", e164: `+1${last10}`, last10 };
}

/**
 * Claim password rule (from the build spec): at least 8 characters with an
 * uppercase letter, a lowercase letter, and a symbol. No digit requirement.
 * Returns a user-facing message for the first failed rule, or null when the
 * password passes. Supabase additionally enforces min length 8 and blocks
 * known-leaked passwords server-side.
 */
export function passwordIssue(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) {
    return "Passwords need at least 8 characters.";
  }
  if (password.length > 72) {
    return "Passwords max out at 72 characters.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Add at least one uppercase letter.";
  }
  if (!/[a-z]/.test(password)) {
    return "Add at least one lowercase letter.";
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return "Add at least one symbol, like ! or #.";
  }
  return null;
}

/** "•••-•••-1234" / "a•••@g•••" — enough to recognize, never enough to learn. */
export function maskIdentifier(identifier: NormalizedIdentifier): string {
  if (identifier.kind === "phone") {
    return `•••-•••-${identifier.last10.slice(-4)}`;
  }
  const [local, domain = ""] = identifier.email.split("@");
  const maskedLocal = `${local.slice(0, 1)}•••`;
  const maskedDomain = domain ? `${domain.slice(0, 1)}•••` : "•••";
  return `${maskedLocal}@${maskedDomain}`;
}
