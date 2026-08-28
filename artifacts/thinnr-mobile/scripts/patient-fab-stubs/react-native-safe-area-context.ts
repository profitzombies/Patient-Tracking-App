/** Node stand-in for react-native-safe-area-context with settable insets. */
let insets = { top: 0, bottom: 0, left: 0, right: 0 };

export function setInsets(next: Partial<typeof insets>): void {
  insets = { ...insets, ...next };
}

export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  return insets;
}
