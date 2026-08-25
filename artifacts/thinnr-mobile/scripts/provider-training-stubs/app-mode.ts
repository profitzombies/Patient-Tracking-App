/**
 * Node stand-in for '@/context/AppModeContext' used by the provider-training
 * suite (see tsconfig.provider-training.json `paths`).
 *
 * The real context hydrates the persona from AsyncStorage; the suite drives
 * it directly. Defaults to the hydrated staff persona (the only mode that
 * can reach the training screens).
 */
export type AppMode = 'staff' | 'patient' | null;

let mode: AppMode = 'staff';
let hydrated = true;

export function setAppMode(nextMode: AppMode, nextHydrated = true): void {
  mode = nextMode;
  hydrated = nextHydrated;
}

export function useAppMode() {
  return {
    mode,
    hydrated,
    setMode: (_next: AppMode) => {},
  };
}
