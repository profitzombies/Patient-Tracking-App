export type AppMode = 'patient' | 'staff' | null;

export const appModeState: {
  mode: AppMode;
  hydrated: boolean;
} = {
  mode: 'patient',
  hydrated: true,
};

export function useAppMode() {
  return {
    mode: appModeState.mode,
    hydrated: appModeState.hydrated,
  };
}
