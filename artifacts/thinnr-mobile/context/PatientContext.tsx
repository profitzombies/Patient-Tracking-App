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
  applyRemoveCustomFood,
  applyRestoreCustomFood,
  captureRemovedCustomFood,
  type RemovedCustomFood,
} from '@/data/custom-food-state';
import { cloneEntriesForCopy } from '@/data/diary-entries';
import {
  applyRemoveEntries,
  applyRemoveEntry,
  applyRestoreEntries,
  applyUpdateEntry,
  type EntryEditChanges,
} from '@/data/diary-entry-state';
import {
  applyRemovePhoto,
  applyRestorePhoto,
  captureRemovedPhoto,
  type RemovedProgressPhoto,
} from '@/data/progress-photo-state';
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
  type MealSlot,
  type ProgressPhoto,
  type SavedRecipe,
} from '@/data/patient-data';

const STORAGE_KEY = 'thinnr_patient_state_v1';

// Seeds are deterministic — compute once per JS runtime.
const SEED_ENTRIES = buildSeedEntries();
const SEED_ENTRY_IDS = new Set(SEED_ENTRIES.map(e => e.id));
const isSeedEntryId = (id: string) => SEED_ENTRY_IDS.has(id);

const findSeedEntry = (id: string) => SEED_ENTRIES.find(e => e.id === id);
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
  savedRecipes: SavedRecipe[];
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
  savedRecipes: [],
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
  savedRecipes: SavedRecipe[];
  allFoods: FoodItem[];
  recents: string[];
  photos: ProgressPhoto[];
  checkIns: CheckIn[]; // merged, newest first
  weightSeries: WeightPoint[]; // ascending by date
  allEntries: MealLogEntry[]; // seeded + user-added, minus removed, in log order
  entriesForDate: (dateKey: string) => MealLogEntry[];
  waterFor: (dateKey: string) => number;
  checkInFor: (dateKey: string) => CheckIn | undefined;
  addEntry: (entry: Omit<MealLogEntry, 'id'>) => Promise<void>;
  copyEntries: (sources: MealLogEntry[], target: { dateKey: string; meal?: MealSlot }) => Promise<MealLogEntry[]>;
  removeEntry: (id: string) => Promise<void>;
  removeEntries: (ids: readonly string[]) => Promise<void>;
  updateEntry: (id: string, changes: EntryEditChanges) => Promise<void>;
  setWater: (dateKey: string, oz: number) => Promise<void>;
  addCheckIn: (checkIn: Omit<CheckIn, 'id'>) => Promise<void>;
  addPhoto: (photo: { dateKey: string; uri: string; label: string }) => Promise<void>;
  removePhoto: (id: string) => Promise<RemovedProgressPhoto | null>;
  restorePhoto: (removed: RemovedProgressPhoto) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  addCustomFood: (food: Omit<FoodItem, 'id' | 'category'>) => Promise<FoodItem>;
  updateCustomFood: (id: string, food: Omit<FoodItem, 'id' | 'category'>) => Promise<void>;
  removeCustomFood: (id: string) => Promise<RemovedCustomFood | null>;
  restoreCustomFood: (removed: RemovedCustomFood) => Promise<void>;
  addSavedRecipe: (recipe: Omit<SavedRecipe, 'id'>) => Promise<SavedRecipe>;
  setCustomFoodPhoto: (id: string, photoUri: string) => Promise<void>;
  setSavedRecipePhoto: (id: string, photoUri: string) => Promise<void>;
  setTargets: (partial: Partial<DailyTargets>) => Promise<void>;
  restoreEntry: (entry: MealLogEntry) => Promise<void>;
  restoreEntries: (entries: MealLogEntry[]) => Promise<void>;
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

  // Every read-modify-write mutation runs through a single promise chain, so
  // it reads state only after the previous commit has finished. Without this,
  // two in-flight mutations (e.g. a delete and a fast Undo) could both read
  // the same pre-delete state and the later commit would silently drop the
  // earlier one's write.
  const mutationChain = useRef<Promise<void>>(Promise.resolve());
  const runSerialized = useCallback(<T,>(mutate: () => Promise<T>): Promise<T> => {
    const run = mutationChain.current.then(mutate);
    mutationChain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    await runSerialized(async () => {
      const prev = stateRef.current;
      const full: MealLogEntry = { ...entry, id: nextId('log') };
      const recents = entry.refId
        ? [entry.refId, ...prev.recents.filter(r => r !== entry.refId)].slice(0, 12)
        : prev.recents;
      await commit({ ...prev, addedEntries: [...prev.addedEntries, full], recents });
    });
  }, [commit, runSerialized]);

  // Copies already-logged entries (seeded or user-added, from any day) onto a
  // target day — optionally into one meal slot — as user-added entries with
  // fresh ids. Clones keep each source's logged snapshot rather than current
  // library values, and the whole batch lands in a single commit so day
  // totals update and persist atomically. Recents are left alone: copying a
  // day is repetition, not a new food choice. Returns the created clones —
  // captured inside the serialized mutation, so they are exactly what this
  // copy committed — letting the caller arm an Undo for just this batch.
  const copyEntries = useCallback(async (sources: MealLogEntry[], target: { dateKey: string; meal?: MealSlot }): Promise<MealLogEntry[]> => {
    if (sources.length === 0) return [];
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const prev = stateRef.current;
      const clones = cloneEntriesForCopy(sources, target, () => nextId('log'));
      await commit({ ...prev, addedEntries: [...prev.addedEntries, ...clones] });
      return clones;
    });
  }, [commit, runSerialized]);

  const removeEntry = useCallback(async (id: string): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const next = applyRemoveEntry(prev, id, isSeedEntryId);
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // nothing to delete (e.g. the second tap of a double-tapped remove)
      }
      await commit({ ...prev, ...next });
    });
  }, [commit, runSerialized]);

  // Undo for copyEntries — takes back a whole batch of entries (the clone ids
  // one copy created) in a single commit, so day totals return to their
  // pre-copy values in one step. Ids that are already gone (a double-tapped
  // Undo, or a clone the patient deleted by hand before undoing) no-op inside
  // applyRemoveEntries, so the batch can never remove more than the copy
  // actually created.
  const removeEntries = useCallback(async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const next = applyRemoveEntries(prev, ids, isSeedEntryId);
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // nothing left to remove (e.g. a double-tapped copy Undo)
      }
      await commit({ ...prev, ...next });
    });
  }, [commit, runSerialized]);

  // Undo for removeEntry — accepts the whole batch from a rapid multi-delete
  // clean-up so one Undo restores every affected entry in a single commit
  // (one storage write, one totals update). Seeded entries were tombstoned,
  // so restoring drops the tombstone and the original seeded row reappears in
  // place. User-logged entries were filtered out of addedEntries, so the
  // exact snapshot is re-added under its original id. Only actual recorded
  // deletions are undone: double-taps, or an Undo somehow arriving before its
  // deletion, no-op instead of appending duplicates (see applyRestoreEntries).
  const restoreEntries = useCallback(async (entries: MealLogEntry[]): Promise<void> => {
    if (entries.length === 0) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const next = applyRestoreEntries(prev, entries, isSeedEntryId);
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // nothing to undo
      }
      await commit({ ...prev, ...next });
    });
  }, [commit, runSerialized]);

  const restoreEntry = useCallback(
    (entry: MealLogEntry): Promise<void> => restoreEntries([entry]),
    [restoreEntries],
  );

  // Fixes a logged entry in place (meal slot, quantity, and/or day) through
  // the pure applyUpdateEntry transition (data/diary-entry-state.ts, covered
  // by scripts/verify-diary-edit.ts). Macros rescale from the entry's own
  // logged snapshot — never the current library food, which may have changed
  // since. Seeded entries can't be mutated (they're rebuilt from the seed
  // each launch), so they're tombstoned via removedEntryIds and re-added as
  // a user entry with a fresh id.
  const updateEntry = useCallback(async (id: string, changes: EntryEditChanges): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const next = applyUpdateEntry(prev, id, changes, findSeedEntry, () => nextId('log'));
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // unknown id, or an already-deleted/edited entry — nothing to change
      }
      await commit({ ...prev, ...next });
    });
  }, [commit, runSerialized]);

  const setWater = useCallback(async (dateKey: string, oz: number): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const clamped = Math.max(0, Math.min(200, Math.round(oz)));
      await commit({ ...prev, waterOverrides: { ...prev.waterOverrides, [dateKey]: clamped } });
    });
  }, [commit, runSerialized]);

  const addCheckIn = useCallback(async (checkIn: Omit<CheckIn, 'id'>): Promise<void> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const full: CheckIn = { ...checkIn, id: nextId('ci') };
      await commit({
        ...prev,
        addedCheckIns: [...prev.addedCheckIns.filter(c => c.dateKey !== checkIn.dateKey), full],
      });
    });
  }, [commit, runSerialized]);

  const addPhoto = useCallback(async (photo: { dateKey: string; uri: string; label: string }): Promise<void> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const full: ProgressPhoto = { id: nextId('photo'), source: 'user', ...photo };
      await commit({ ...prev, photos: [...prev.photos, full] });
    });
  }, [commit, runSerialized]);

  // Removes a user-added progress photo. Seed photos are not removable: they
  // never live in the persisted array, and the state helper's source guard
  // makes a seed id a no-op regardless. Returns the pre-removal snapshot
  // (photo + position) so the caller can offer an Undo; the capture happens
  // inside the serialized mutation, so it reflects exactly what this delete
  // dropped. Returns null when the id isn't a removable photo (double-tap).
  // On web this commit is also what frees the base64 image data from browser
  // storage — once the caller's undo window lapses, nothing references it.
  const removePhoto = useCallback(async (id: string): Promise<RemovedProgressPhoto | null> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const prev = stateRef.current;
      const removed = captureRemovedPhoto(prev.photos, id);
      const nextPhotos = applyRemovePhoto(prev.photos, id);
      if (nextPhotos !== prev.photos) {
        await commit({ ...prev, photos: nextPhotos });
      }
      return removed;
    });
  }, [commit, runSerialized]);

  // Undo for removePhoto. Re-inserts the exact snapshot under its original id
  // at its captured position. Only an actual recorded removal is undone: a
  // double-tapped Undo no-ops instead of inserting a duplicate (see
  // applyRestorePhoto).
  const restorePhoto = useCallback(async (removed: RemovedProgressPhoto): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const nextPhotos = applyRestorePhoto(prev.photos, removed);
      if (nextPhotos === prev.photos) {
        return; // nothing to undo
      }
      await commit({ ...prev, photos: nextPhotos });
    });
  }, [commit, runSerialized]);

  const toggleFavorite = useCallback(async (id: string): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const favorites = prev.favorites.includes(id)
        ? prev.favorites.filter(f => f !== id)
        : [...prev.favorites, id];
      await commit({ ...prev, favorites });
    });
  }, [commit, runSerialized]);

  const addCustomFood = useCallback(async (food: Omit<FoodItem, 'id' | 'category'>): Promise<FoodItem> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const prev = stateRef.current;
      const full: FoodItem = { ...food, id: nextId('custom'), category: 'My Foods' };
      await commit({ ...prev, customFoods: [...prev.customFoods, full] });
      return full;
    });
  }, [commit, runSerialized]);

  // Rebuilds the food from the payload (not a merge) so cleared optional
  // fields like brand actually drop. Diary entries are untouched: they
  // snapshot name/calories/macros at log time.
  const updateCustomFood = useCallback(async (id: string, food: Omit<FoodItem, 'id' | 'category'>): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      await commit({
        ...prev,
        customFoods: prev.customFoods.map(f => (f.id === id ? { ...food, id, category: 'My Foods' } : f)),
      });
    });
  }, [commit, runSerialized]);

  // Existing diary entries keep their logged values; only the library item
  // (plus any dangling favorite/recent references) goes away. Returns the
  // pre-removal snapshot — food, favorite and recents references with their
  // positions — so the caller can offer an Undo; the capture happens inside
  // the serialized mutation, so it reflects exactly what this delete
  // stripped. Returns null when the id isn't a custom food (double-tap).
  const removeCustomFood = useCallback(async (id: string): Promise<RemovedCustomFood | null> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const prev = stateRef.current;
      const removed = captureRemovedCustomFood(prev, id);
      const next = applyRemoveCustomFood(prev, id);
      if (next !== prev) {
        await commit({ ...prev, ...next });
      }
      return removed;
    });
  }, [commit, runSerialized]);

  // Undo for removeCustomFood. Re-inserts the exact snapshot under its
  // original id and re-attaches the favorite/recents references the removal
  // stripped. Only an actual recorded deletion is undone: a double-tapped
  // Undo no-ops instead of inserting a duplicate (see applyRestoreCustomFood).
  const restoreCustomFood = useCallback(async (removed: RemovedCustomFood): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      const next = applyRestoreCustomFood(prev, removed);
      if (next === prev) {
        return; // nothing to undo
      }
      await commit({ ...prev, ...next });
    });
  }, [commit, runSerialized]);

  // Keeps an AI suggestion permanently (Library > Recipes). Stored whole —
  // including the generated photo data URI — so it survives restarts exactly
  // like custom foods do.
  const addSavedRecipe = useCallback(async (recipe: Omit<SavedRecipe, 'id'>): Promise<SavedRecipe> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    const full: SavedRecipe = { ...recipe, id: nextId('airec') };
    await commit({ ...prev, savedRecipes: [...prev.savedRecipes, full] });
    return full;
  }, [commit]);

  // Photo backfill for AI suggestions saved while their dish photo was still
  // generating: patch just the photo onto the already-persisted record. No
  // haptics — these fire programmatically when generation resolves, not from
  // a user gesture.
  const setCustomFoodPhoto = useCallback(async (id: string, photoUri: string): Promise<void> => {
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    if (!prev.customFoods.some(f => f.id === id)) return;
    await commit({
      ...prev,
      customFoods: prev.customFoods.map(f => (f.id === id ? { ...f, photoUri } : f)),
    });
  }, [commit]);

  const setSavedRecipePhoto = useCallback(async (id: string, photoUri: string): Promise<void> => {
    await hydrationGate.current!.promise;
    const prev = stateRef.current;
    if (!prev.savedRecipes.some(r => r.id === id)) return;
    await commit({
      ...prev,
      savedRecipes: prev.savedRecipes.map(r => (r.id === id ? { ...r, photoUri } : r)),
    });
  }, [commit]);

  const setTargets = useCallback(async (partial: Partial<DailyTargets>): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const prev = stateRef.current;
      await commit({ ...prev, targetOverrides: { ...prev.targetOverrides, ...partial } });
    });
  }, [commit, runSerialized]);

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

  // Stable ascending sort: equal dateKeys keep concatenation order (seeds
  // first, then user photos in add order), so two photos added the same day
  // display oldest-first and their de-duplicated "Week N (2)" counters read
  // in the order they were added.
  const photos = useMemo(
    () =>
      [...SEED_PHOTOS, ...state.photos].sort((a, b) =>
        a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0,
      ),
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
      savedRecipes: state.savedRecipes,
      allFoods,
      recents: state.recents,
      photos,
      checkIns,
      weightSeries,
      allEntries,
      entriesForDate,
      waterFor,
      checkInFor,
      addEntry,
      copyEntries,
      removeEntry,
      removeEntries,
      restoreEntry,
      restoreEntries,
      updateEntry,
      setWater,
      addCheckIn,
      addPhoto,
      removePhoto,
      restorePhoto,
      toggleFavorite,
      addCustomFood,
      updateCustomFood,
      removeCustomFood,
      restoreCustomFood,
      addSavedRecipe,
      setCustomFoodPhoto,
      setSavedRecipePhoto,
      setTargets,
    }),
    [
      hydrated,
      targets,
      state.favorites,
      state.customFoods,
      state.savedRecipes,
      allFoods,
      state.recents,
      photos,
      checkIns,
      weightSeries,
      allEntries,
      entriesForDate,
      waterFor,
      checkInFor,
      addEntry,
      copyEntries,
      removeEntry,
      removeEntries,
      restoreEntry,
      restoreEntries,
      updateEntry,
      setWater,
      addCheckIn,
      addPhoto,
      removePhoto,
      restorePhoto,
      toggleFavorite,
      addCustomFood,
      updateCustomFood,
      removeCustomFood,
      restoreCustomFood,
      addSavedRecipe,
      setCustomFoodPhoto,
      setSavedRecipePhoto,
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
