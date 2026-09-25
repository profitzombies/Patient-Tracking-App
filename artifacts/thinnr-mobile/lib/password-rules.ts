/**
 * Patient password rules — must match the server's `passwordIssue` exactly
 * (api-server claim/normalize.ts): 8–72 characters with an uppercase letter,
 * a lowercase letter and a symbol. No digit requirement.
 */
export const PASSWORD_MAX_LENGTH = 72;

export const PASSWORD_RULES = [
  { key: 'length', label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { key: 'upper', label: 'An uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { key: 'lower', label: 'A lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { key: 'symbol', label: 'A symbol (like ! or #)', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export type PasswordRuleKey = (typeof PASSWORD_RULES)[number]['key'];

export function passwordChecks(password: string) {
  return PASSWORD_RULES.map(rule => ({ key: rule.key, label: rule.label, met: rule.test(password) }));
}

/** Every rule met and within the server's upper bound. */
export function passwordMeetsRules(password: string): boolean {
  return password.length <= PASSWORD_MAX_LENGTH && PASSWORD_RULES.every(rule => rule.test(password));
}
