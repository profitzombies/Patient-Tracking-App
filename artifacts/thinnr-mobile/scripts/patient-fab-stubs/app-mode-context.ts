/**
 * Node stand-in for @/context/AppModeContext: the persona gate as plain
 * mutable state. The suite flips `mode` to prove the patient layout (and
 * with it the corner launcher) only renders for the patient persona.
 */
export type AppMode = 'patient' | 'staff' | null;

export const appModeState: { mode: AppMode; hydrated: boolean } = {
  mode: 'patient',
  hydrated: true,
};

export function useAppMode() {
  return {
    mode: appModeState.mode,
    hydrated: appModeState.hydrated,
    demoAdmitted: true,
    async setMode(_next: AppMode): Promise<void> {},
    async clearMode(): Promise<void> {},
  };
}
