/**
 * Patient-mode state: deterministic seeded history merged with the user's own
 * logged entries, water, check-ins, photos, favorites, and target overrides.
 * Follows the same persistence pattern as OperationsContext (ref-backed
 * commits awaited through storage).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import {
  buildSeedCheckIns,
  buildSeedEntries,
  buildSeedWater,
  DEFAULT_TARGETS,
  FOOD_DB,
  PATIENT_PROFILE,
  SEED_PHOTOS,
  toDateKey,
  type CheckIn,
  type DailyTargets,
  type FoodItem,
  type MealLogEntry,
  type ProgressPhoto,
} from '@/data/patient-data';

const STORAGE_KEY = 'thinnr_patient_state_v1';

// Seeds are deterministic — compute once per JS runtime.
const SEED_ENTRIES = buildSeedEntries();
const SEED_WATER = buildSeedWater();
const SEED_CHECKINS = buildSeedCheckIns();

async function readPersistedState(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  }
  return AsyncStorage.getItem(STORAGE_KEY);
}

async function writePersistedState(next: PersistedState): Promise<void> {
  const serialized = JSON.stringify(next);
  if (Platform.OS === 'web') {
    const storage = globalThis.localStorage;
    if (!storage) {
      throw new Error('Browser local storage is unavailable.');
    }
    storage.setItem(STORAGE_KEY, serialized);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, serialized);
}

interface PersistedState {
  addedEntries: MealLogEntry[];
  removedEntryIds: string[];
  waterOverrides: Record<string, number>;
  addedCheckIns: CheckIn[];
  photos: ProgressPhoto[];
  favorites: string[];
  customFoods: FoodItem[];
  recents: string[];
  targetOverrides: Partial<DailyTargets>;
}

const EMPTY_STATE: PersistedState = {
  addedEntries: [],
  removedEntryIds: [],
  waterOverrides: {},
  addedCheckIns: [],
  photos: [],
  favorites: [],
  customFoods: [],
  recents: [],
  targetOverrides: {},
};

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

export interface WeightPoint {
  dateKey: string;
  weight: number;
}

interface PatientContextValue {
  hydrated: boolean;
  targets: DailyTargets;
  favorites: string[];
  customFoods: FoodItem[];
  allFoods: FoodItem[];
  recents: string[];
  photos: ProgressPhoto[];
  checkIns: CheckIn[]; // merged, newest first
  weightSeries: WeightPoint[]; // ascending by date
  entriesForDate: (dateKey: string) => MealLogEntry[];
  waterFor: (dateKey: string) => number;
  checkInFor: (dateKey: string) => CheckIn | undefined;
  addEntry: (entry: Omit<MealLogEntry, 'id'>) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  setWater: (dateKey: string, oz: number) => Promise<void>;
  addCheckIn: (checkIn: Omit<CheckIn, 'id'>) => Promise<void>;
  addPhoto: (photo: { dateKey: string; uri: string; label: string }) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  addCustomFood: (food: Omit<FoodItem, 'id' | 'category'>) => Promise<FoodItem>;
  updateCustomFood: (id: string, food: Omit<FoodItem, 'id' | 'category'>) => Promise<void>;
  removeCustomFood: (id: string) => Promise<void>;
  setTargets: (partial: Partial<DailyTargets>) => Promise<void>;
}

const PatientContext = createContext<PatientContextValue | null>(null);

export function PatientProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<PersistedState>(EMPTY_STATE);
  const stateRef = useRef<PersistedState>(EMPTY_STATE);

  // Mutations must wait for hydration: a pre-hydration commit would build on
  // EMPTY_STATE and clobber previously persisted data in storage.
  const hydrationGate = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!hydrationGate.current) {
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
      resolve = r;
    });
    hydrationGate.current = { promise, resolve };
  }

  const commit = useCallback(async (next: PersistedState): Promise<void> => {
    stateRef.current = next;
    setState(next);
    await writePersistedState(next);
  }, []);

  useEffect(() => {
    readPersistedState()
      .then(raw => {
        if (raw) {
          try {
            const parsed = { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<PersistedState>) };
            stateRef.current = parsed;
            setState(parsed);
          } catch {
            // ignore corrupt data
          }
        }
      })
      .finally(() => {
        setHydrated(true);
        hydrationGate.current?.resolve();
      });
  }, []);

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const addEntry = useCallback(async (entry: Omit<MealLogEntry, 'id'>): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const full: MealLogEntry = { ...entry, id: nextId('log') };
    const recents = entry.refId
      ? [entry.refId, ...prev.recents.filter(r => r !== entry.refId)].slice(0, 12)
      : prev.recents;
    await commit({ ...prev, addedEntries: [...prev.addedEntries, full], recents });
  }, [commit]);

  const removeEntry = useCallback(async (id: string): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const isAdded = prev.addedEntries.some(e => e.id === id);
    const next: PersistedState = isAdded
      ? { ...prev, addedEntries: prev.addedEntries.filter(e => e.id !== id) }
      : { ...prev, removedEntryIds: [...prev.removedEntryIds, id] };
    await commit(next);
  }, [commit]);

  const setWater = useCallback(async (dateKey: string, oz: number): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const clamped = Math.max(0, Math.min(200, Math.round(oz)));
    await commit({ ...prev, waterOverrides: { ...prev.waterOverrides, [dateKey]: clamped } });
  }, [commit]);

  const addCheckIn = useCallback(async (checkIn: Omit<CheckIn, 'id'>): Promise<void> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const full: CheckIn = { ...checkIn, id: nextId('ci') };
    await commit({
      ...prev,
      addedCheckIns: [...prev.addedCheckIns.filter(c => c.dateKey !== checkIn.dateKey), full],
    });
  }, [commit]);

  const addPhoto = useCallback(async (photo: { dateKey: string; uri: string; label: string }): Promise<void> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const full: ProgressPhoto = { id: nextId('photo'), source: 'user', ...photo };
    await commit({ ...prev, photos: [...prev.photos, full] });
  }, [commit]);

  const toggleFavorite = useCallback(async (id: string): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const favorites = prev.favorites.includes(id)
      ? prev.favorites.filter(f => f !== id)
      : [...prev.favorites, id];
    await commit({ ...prev, favorites });
  }, [commit]);

  const addCustomFood = useCallback(async (food: Omit<FoodItem, 'id' | 'category'>): Promise<FoodItem> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const full: FoodItem = { ...food, id: nextId('custom'), category: 'My Foods' };
    await commit({ ...prev, customFoods: [...prev.customFoods, full] });
    return full;
  }, [commit]);

  // Rebuilds the food from the payload (not a merge) so cleared optional
  // fields like brand actually drop. Diary entries are untouched: they
  // snapshot name/calories/macros at log time.
  const updateCustomFood = useCallback(async (id: string, food: Omit<FoodItem, 'id' | 'category'>): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    await commit({
      ...prev,
      customFoods: prev.customFoods.map(f => (f.id === id ? { ...food, id, category: 'My Foods' } : f)),
    });
  }, [commit]);

  // Existing diary entries keep their logged values; only the library item
  // (plus any dangling favorite/recent references) goes away.
  const removeCustomFood = useCallback(async (id: string): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    await commit({
      ...prev,
      customFoods: prev.customFoods.filter(f => f.id !== id),
      favorites: prev.favorites.filter(f => f !== id),
      recents: prev.recents.filter(r => r !== id),
    });
  }, [commit]);

  const setTargets = useCallback(async (partial: Partial<DailyTargets>): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    await commit({ ...prev, targetOverrides: { ...prev.targetOverrides, ...partial } });
  }, [commit]);

  // ─── Merged projections ────────────────────────────────────────────────────

  const targets = useMemo<DailyTargets>(
    () => ({ ...DEFAULT_TARGETS, ...state.targetOverrides }),
    [state.targetOverrides],
  );

  const allEntries = useMemo(() => {
    const removed = new Set(state.removedEntryIds);
    return [...SEED_ENTRIES, ...state.addedEntries].filter(e => !removed.has(e.id));
  }, [state.removedEntryIds, state.addedEntries]);

  const entriesForDate = useCallback(
    (dateKey: string) => allEntries.filter(e => e.dateKey === dateKey),
    [allEntries],
  );

  const waterFor = useCallback(
    (dateKey: string) => state.waterOverrides[dateKey] ?? SEED_WATER[dateKey] ?? 0,
    [state.waterOverrides],
  );

  const checkIns = useMemo(() => {
    const userDates = new Set(state.addedCheckIns.map(c => c.dateKey));
    return [...SEED_CHECKINS.filter(c => !userDates.has(c.dateKey)), ...state.addedCheckIns]
      .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  }, [state.addedCheckIns]);

  const checkInFor = useCallback(
    (dateKey: string) => checkIns.find(c => c.dateKey === dateKey),
    [checkIns],
  );

  const weightSeries = useMemo<WeightPoint[]>(() => {
    const byDate = new Map<string, number>();
    byDate.set(toDateKey(new Date(PATIENT_PROFILE.startDate)), PATIENT_PROFILE.startingWeight);
    [...checkIns]
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
      .forEach(c => {
        if (typeof c.weight === 'number') byDate.set(c.dateKey, c.weight);
      });
    return [...byDate.entries()]
      .map(([dateKey, weight]) => ({ dateKey, weight }))
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  }, [checkIns]);

  const photos = useMemo(
    () => [...SEED_PHOTOS, ...state.photos].sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)),
    [state.photos],
  );

  const allFoods = useMemo(
    () => [...state.customFoods, ...FOOD_DB],
    [state.customFoods],
  );

  const value = useMemo<PatientContextValue>(
    () => ({
      hydrated,
      targets,
      favorites: state.favorites,
      customFoods: state.customFoods,
      allFoods,
      recents: state.recents,
      photos,
      checkIns,
      weightSeries,
      entriesForDate,
      waterFor,
      checkInFor,
      addEntry,
      removeEntry,
      setWater,
      addCheckIn,
      addPhoto,
      toggleFavorite,
      addCustomFood,
      updateCustomFood,
      removeCustomFood,
      setTargets,
    }),
    [
      hydrated,
      targets,
      state.favorites,
      state.customFoods,
      allFoods,
      state.recents,
      photos,
      checkIns,
      weightSeries,
      entriesForDate,
      waterFor,
      checkInFor,
      addEntry,
      removeEntry,
      setWater,
      addCheckIn,
      addPhoto,
      toggleFavorite,
      addCustomFood,
      updateCustomFood,
      removeCustomFood,
      setTargets,
    ],
  );

  return <PatientContext.Provider value={value}>{children}</PatientContext.Provider>;
}

export function usePatient() {
  const ctx = useContext(PatientContext);
  if (!ctx) throw new Error('usePatient must be used within PatientProvider');
  return ctx;
}
