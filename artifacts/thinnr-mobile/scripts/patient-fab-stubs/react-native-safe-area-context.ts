/**
 * Node stand-in for react-native-safe-area-context. A phone-like bottom
 * inset (home indicator) so the suite can tell the patient placement
 * formula (insets + tab bar + gap) apart from the staff one
 * (max(insets, 14) + 14) — with 0-insets both sides of several branches
 * would collapse to the same number.
 */
export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  return { top: 59, bottom: 34, left: 0, right: 0 };
}
