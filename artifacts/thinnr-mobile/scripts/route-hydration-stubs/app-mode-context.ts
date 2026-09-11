export type AppMode = 'patient' | 'staff' | null;

export const appModeState: {
  mode: AppMode;
  hydrated: boolean;
  demoAdmitted: boolean;
} = {
  mode: 'patient',
  hydrated: true,
  demoAdmitted: true,
};

export function useAppMode() {
  return {
    mode: appModeState.mode,
    hydrated: appModeState.hydrated,
    demoAdmitted: appModeState.demoAdmitted,
  };
}