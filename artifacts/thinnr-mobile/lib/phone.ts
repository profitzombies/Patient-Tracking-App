/**
 * Pure phone-number helpers shared by sign-in, signup, claiming, and the
 * onboarding identity step. Kept free of native/Supabase imports so Node
 * suites can load them directly.
 */

/**
 * Normalize a user-typed phone number to E.164. Ten digits are treated as US.
 * Returns '' when the input can't be a dialable number.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
}
