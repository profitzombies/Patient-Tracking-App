import {
  DEFAULT_TARGETS,
  PATIENT_PROFILE,
  TODAY_KEY,
} from '@/data/patient-data';

export const PROGRESS_UNDO_WINDOW_MS = 30_000;

const patient = {
  hydrated: true,
  todayKey: TODAY_KEY,
  profile: PATIENT_PROFILE,
  entryFacts: undefined,
  targets: DEFAULT_TARGETS,
  favorites: [] as string[],
  customFoods: [] as never[],
  catalogFoods: [] as never[],
  savedRecipes: [] as never[],
  allFoods: [] as never[],
  recents: [] as string[],
  photos: [] as never[],
  checkIns: [] as never[],
  weightSeries: [] as Array<{ dateKey: string; weight: number }>,
  allEntries: [] as never[],
  medications: [] as never[],
  doseLogs: [] as never[],
  entriesForDate: (_dateKey: string) => [] as never[],
  waterFor: (_dateKey: string) => 0,
  checkInFor: (_dateKey: string) => undefined,
  addEntry: async (_entry: unknown) => {},
  addEntries: async (_entries: unknown) => {},
  removeEntry: async (_id: string) => {},
  removeEntries: async (_ids: string[]) => {},
  restoreEntries: async (_entries: unknown) => {},
  updateEntry: async (_id: string, _patch: unknown) => {},
  copyEntries: async (_from: string, _to: string) => {},
  setWater: async (_dateKey: string, _amount: number) => {},
  setTargets: async (_targets: unknown) => {},
  addPhoto: async (_photo: unknown) => {},
  addPhotos: async (_photos: unknown) => {},
  removePhoto: async (_id: string) => {},
  restorePhoto: async (_photo: unknown) => {},
  toggleFavorite: async (_id: string) => {},
  saveCatalogFood: async (_food: unknown) => {},
  removeCustomFood: async (_id: string) => {},
  restoreCustomFood: async (_food: unknown) => {},
  logDose: async (_input: unknown) => true,
  clearLocalState: async () => {},
};

export function usePatient() {
  return patient;
}

export function usePatientSync() {
  return {
    enabled: false,
    online: true,
    status: 'idle' as const,
    items: [] as never[],
    pendingCount: 0,
    failedCount: 0,
    slowSync: false,
    justSynced: false,
    isPending: () => false,
    retry: () => undefined,
    retryAll: () => undefined,
    discard: async () => undefined,
  };
}