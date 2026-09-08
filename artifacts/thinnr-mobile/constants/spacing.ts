/**
 * 8-point spacing scale. Layout rhythm on the auth entry screens (welcome,
 * login, signup, provider login) is built exclusively from these steps so
 * gaps stay consistent between hero, heading, form, actions, and footer.
 */
export const space = {
  /** 4 — hairline nudges (label tracking, icon gaps). */
  xs: 4,
  /** 8 — label-to-field, inline link offsets. */
  sm: 8,
  /** 16 — field-to-field, card interior padding. */
  md: 16,
  /** 24 — between major blocks (hero → heading → form → footer). */
  lg: 24,
  /** 32 — breathing room around the primary action group. */
  xl: 32,
  /** 40 — top/bottom page slack on tall phones. */
  xxl: 40,
} as const;

/** Shared page geometry for the auth entry screens (matches the onboarding frame). */
export const authLayout = {
  maxContentWidth: 520,
  pagePadding: 20,
  /** Back button / header control size and the header's side padding. */
  headerControl: 44,
  headerPadding: 16,
} as const;
