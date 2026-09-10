export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  return { top: 59, bottom: 34, left: 0, right: 0 };
}

export function useSafeAreaFrame(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: 393, height: 852 };
}

export function SafeAreaProvider({ children }: { children?: unknown }): unknown {
  return children;
}