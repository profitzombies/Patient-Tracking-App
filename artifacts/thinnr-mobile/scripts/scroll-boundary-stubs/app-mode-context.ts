export function useAppMode() {
  return { mode: 'patient' as const, hydrated: true, setMode: async () => {}, clearMode: async () => {} };
}