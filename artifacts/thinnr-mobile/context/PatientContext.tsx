/**
 * Patient-mode state, in two modes decided by PatientAccountContext:
 *
 *  - Demo persona (the default): deterministic seeded history merged with the
 *    user's own logged entries, water, check-ins, photos, favorites, and
 *    target overrides — persisted locally under one storage key. This is the
 *    pre-live behavior, byte for byte: trees that render PatientProvider
 *    without the account resolver (every Node test suite) land here.
 *
 *  - Real account: a signed-in patient's diary lives on the server. No seed
 *    data at all; entries, water, targets, favorites, recents, custom foods,
 *    saved recipes, progress photos, check-ins, and the nudge/onboarding
 *    flags hydrate from the patient-data API and every mutation writes
 *    through it — optimistic commit first, rolled back with a visible sync
 *    notice if the server write fails. Progress-photo deletes are deferred:
 *    the grid row drops locally at once, and the server row + stored bytes
 *    go away only after the undo window closes (commitPhotoRemoval).
 *
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
import { buildCopyWithExtras, cloneEntriesForCopy } from '@/data/diary-entries';
import { setPatientMediaToken } from '@/lib/media-token-holder';
import { localTodayKey } from '@/lib/live-patient-entry';
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
  TODAY_KEY,
  type CheckIn,
  type DailyTargets,
  type FoodItem,
  type MealLogEntry,
  type MealSlot,
  type ProgressPhoto,
  type SavedRecipe,
} from '@/data/patient-data';
import {
  assessNudge,
  classifyEntries,
  shouldSeedOutreach,
  type NudgeAssessment,
} from '@/data/stall-nudge';
import {
  usePatientAccount,
  type PatientAccount,
  type PatientDataApi,
  type PatientFlagsWrite,
  type PatientEntryFacts,
  type PatientProfile,
  type PatientProfileWrite,
  type PatientSetupWrite,
  type ProgressPhotoWire,
} from './PatientAccountContext';

const STORAGE_KEY = 'thinnr_patient_state_v1';

// Seeds are deterministic — compute once per JS runtime.
const SEED_ENTRIES = buildSeedEntries();
const SEED_ENTRY_IDS = new Set(SEED_ENTRIES.map(e => e.id));
const isSeedEntryId = (id: string) => SEED_ENTRY_IDS.has(id);

const findSeedEntry = (id: string) => SEED_ENTRIES.find(e => e.id === id);
const SEED_WATER = buildSeedWater();
const SEED_CHECKINS = buildSeedCheckIns();

// Real accounts have no seed data: stable empty stand-ins keep the
// projection memos' identities steady, and the never-seed predicates make
// every diary transition treat all entries as the patient's own.
const NO_SEED_ENTRIES: MealLogEntry[] = [];
const NO_SEED_CHECKINS: CheckIn[] = [];
const NO_SEED_PHOTOS: ProgressPhoto[] = [];
const neverSeedEntryId = (_id: string) => false;
const neverFindSeedEntry = (_id: string) => undefined;

/**
 * Where an account's local layer lives. The demo persona keeps the original
 * key (unchanged data for existing installs); each real account gets its own
 * key so one device can host different sign-ins without mixing their data.
 */
function storageKeyFor(account: PatientAccount): string {
  return account.kind === 'real' ? `${STORAGE_KEY}:acct_${account.patientId}` : STORAGE_KEY;
}

async function readPersistedState(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  return AsyncStorage.getItem(key);
}

async function writePersistedState(next: PersistedState, key: string): Promise<void> {
  const serialized = JSON.stringify(next);
  if (Platform.OS === 'web') {
    const storage = globalThis.localStorage;
    if (!storage) {
      throw new Error('Browser local storage is unavailable.');
    }
    storage.setItem(key, serialized);
    return;
  }
  await AsyncStorage.setItem(key, serialized);
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
  /** Patient paused coach stall nudges (re-enabled from the check-in). */
  nudgeOptOut: boolean;
  /** Patient replied after the current episode's outreach appeared. */
  nudgeEngaged: boolean;
  /** Date key the last outreach seeded on — anchors the cooldown window. */
  nudgeLastSentKey: string | null;
  /** crossedOnKey of the episode that outreach belonged to. */
  nudgeLastCrossingKey: string | null;
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
  nudgeOptOut: false,
  nudgeEngaged: false,
  nudgeLastSentKey: null,
  nudgeLastCrossingKey: null,
};

/**
 * The slices a real account keeps on this device only — none, now that the
 * live rail covers photos, check-ins, and the nudge/onboarding flags too.
 * The function stays as the single choke point every real-account persist
 * goes through, so a stale local copy of any server-backed slice can never
 * resurface into a hydrated account (it also scrubs blobs older installs
 * wrote here back when these slices were device-local).
 */
function localOnlySlice(_state: PersistedState): PersistedState {
  return { ...EMPTY_STATE };
}

/** Grid row → wire shape (display-only fields like uri stay behind). */
function photoWire(photo: ProgressPhoto): ProgressPhotoWire {
  return {
    id: photo.id,
    dateKey: photo.dateKey,
    label: photo.label,
    ...(photo.angle ? { angle: photo.angle } : {}),
    objectPath: photo.objectPath ?? '',
  };
}

/** Wire shape → grid row (every account photo is the patient's own). */
function photoFromWire(wire: ProgressPhotoWire): ProgressPhoto {
  return {
    id: wire.id,
    dateKey: wire.dateKey,
    label: wire.label,
    source: 'user',
    ...(wire.angle ? { angle: wire.angle } : {}),
    objectPath: wire.objectPath,
  };
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

// Real-account ids carry a random suffix on top of the demo scheme: the same
// account can log from two devices at once, and timestamp+sequence alone
// could collide across them. (Demo ids stay exactly as before.)
function nextRealId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}_${Math.random().toString(36).slice(2, 8)}`;
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
  copyEntriesWithExtras: (
    sources: MealLogEntry[],
    extras: Array<Omit<MealLogEntry, 'id'>>,
    target: { dateKey: string; meal: MealSlot },
  ) => Promise<MealLogEntry[]>;
  removeEntry: (id: string) => Promise<void>;
  removeEntries: (ids: readonly string[]) => Promise<void>;
  updateEntry: (id: string, changes: EntryEditChanges) => Promise<void>;
  setWater: (dateKey: string, oz: number) => Promise<void>;
  /**
   * The add-mutations below resolve `true` when the entry is safely
   * recorded (on the account, or locally for the demo persona) and `false`
   * when the account write failed — the optimistic state was rolled back
   * and a sync notice posted. Callers must gate their success UI
   * (announce / close / clear) on the result rather than assuming an
   * awaited call landed.
   */
  addCheckIn: (checkIn: Omit<CheckIn, 'id'>) => Promise<boolean>;
  addPhoto: (photo: {
    dateKey: string;
    label: string;
    uri?: string;
    objectPath?: string;
  }) => Promise<boolean>;
  addPhotos: (
    photos: Array<{
      dateKey: string;
      label: string;
      uri?: string;
      angle?: 'front' | 'side' | 'back';
      objectPath?: string;
    }>,
  ) => Promise<boolean>;
  removePhoto: (id: string) => Promise<RemovedProgressPhoto | null>;
  restorePhoto: (removed: RemovedProgressPhoto) => Promise<void>;
  /**
   * Second half of a photo removal, called once the undo window closes. For
   * a real account this deletes the server record and the stored bytes; the
   * demo persona's local removal was already the whole job (no-op here).
   */
  commitPhotoRemoval: (removed: RemovedProgressPhoto) => Promise<void>;
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
  /** Stall-nudge trigger, read from the merged diary + weigh-in series. */
  nudgeAssessment: NudgeAssessment;
  /** Patient paused coach stall nudges (re-enabled from the check-in). */
  nudgeOptOut: boolean;
  /** Patient replied after the current episode's outreach appeared. */
  nudgeEngaged: boolean;
  /**
   * True when the coach should open the outreach conversation this session:
   * trigger active, not opted out, not engaged for this episode, and outside
   * the cooldown window unless it is the same episode re-showing to a
   * patient who has not answered yet.
   */
  shouldSeedNudgeOutreach: boolean;
  /** Any patient reply to the outreach: stops proactive re-opens. */
  markNudgeEngaged: () => Promise<void>;
  setNudgeOptOut: (optOut: boolean) => Promise<void>;
  /** Stamps the outreach as sent for the current episode (cooldown anchor). */
  recordNudgeSent: () => Promise<void>;
  /**
   * Queue an onboarding/notification flag save for the signed-in account.
   * Honors the hydration gate: writes wait for server truth (a failed
   * hydration keeps them queued behind its retry notice, never dropped),
   * and a failed push surfaces a retryable sync notice. Demo persona and
   * standalone mounts: no-op. Routine answer saves are fire-and-forget.
   */
  saveOnboardingFlags: (flags: Partial<PatientFlagsWrite>) => void;
  /** Persist final onboarding state before protected patient routes unlock. */
  completeOnboarding: (
    flags: Partial<PatientFlagsWrite> & { onboardingComplete: true },
  ) => Promise<boolean>;
  /** Clears only this device's patient companion data before an auth handoff. */
  clearLocalState: () => Promise<void>;
  /**
   * Onboarding answers + notification prefs exactly as the account's
   * hydration delivered them — null before a real hydration and always
   * null for the demo persona. OnboardingProvider initializes a signed-in
   * patient's onboarding state from these so answers survive reload,
   * reinstall, and new devices.
   */
  hydratedFlags: HydratedOnboardingFlags | null;
  /** Live identity/calendar/program facts; null for demo and before hydration. */
  entryFacts: PatientEntryFacts | null;
  /** Canonical account profile; null for demo and before live hydration. */
  profile: PatientProfile | null;
  /** Saves permitted canonical fields and immediately refreshes downstream facts. */
  saveProfile: (partial: PatientProfileWrite) => Promise<boolean>;
  /** Applies a profile returned by a verified-contact/setup mutation. */
  applyProfile: (profile: PatientProfile) => void;
  saveSetup: (input: {
    profile: PatientProfileWrite;
    onboardingAnswers: object;
  }) => Promise<boolean>;
  completeSetup: (input: {
    profile: PatientSetupWrite;
    onboardingAnswers: object;
    notificationPrefs: object;
  }) => Promise<boolean>;
}

/** Onboarding-owned account flags, exactly as hydration delivered them. */
export interface HydratedOnboardingFlags {
  onboardingAnswers: Record<string, unknown> | null;
  notificationPrefs: Record<string, unknown> | null;
  onboardingComplete: boolean;
}

const PatientContext = createContext<PatientContextValue | null>(null);

/**
 * Sync trouble surfaced to the patient: a rolled-back real-account write, a
 * failed live hydration, or a blocked write while the account lookup is
 * down. Rendered by components/patient/PatientSyncNotice.tsx from the root
 * layout — kept out of this file's imports so the Node suites that render
 * PatientProvider never pull UI modules.
 */
export interface PatientSyncNoticeValue {
  message: string;
  actionLabel: string;
  onAction: () => void;
}

const PatientSyncNoticeContext = createContext<PatientSyncNoticeValue | null>(null);

const WRITE_FAILED_MESSAGE = 'That didn’t save. Check your connection and try again.';
const HYDRATE_FAILED_MESSAGE = 'Couldn’t load your diary. Retry in a moment.';
const ACCOUNT_FAILED_MESSAGE = 'Couldn’t load your account. Retry in a moment.';
const ACCOUNT_BLOCKED_MESSAGE = 'Your account isn’t loaded yet. Retry loading before saving.';
const DIARY_BLOCKED_MESSAGE = 'Your diary isn’t loaded yet. Retry loading before saving.';

interface SyncNotice {
  message: string;
  action: 'dismiss' | 'retry-account' | 'retry-hydration' | 'retry-flags';
}

/**
 * How long the Progress screen's Undo snackbar stays actionable after a
 * photo removal. Exported so the screen and this provider share one clock:
 * the provider's backstop commit must never fire while an Undo is still
 * tappable.
 */
export const PROGRESS_UNDO_WINDOW_MS = 5000;
// Provider-owned backstop for deferred photo deletes: fires shortly AFTER
// the screen's undo window closes, so an unmount mid-window (back gesture,
// tab switch) still pushes the delete to the server. The grace keeps the
// normal path — the screen committing exactly at the window — winning the
// race, and no tappable Undo can exist by the time the backstop runs.
const PHOTO_REMOVAL_BACKSTOP_MS = PROGRESS_UNDO_WINDOW_MS + 750;

/** The account generation a mutation runs under (see epochRef below). */
interface MutationRun {
  epoch: number;
  account: PatientAccount;
}

const makeId = (run: MutationRun, prefix: string) =>
  run.account.kind === 'real' ? nextRealId(prefix) : nextId(prefix);

interface HydrationGate {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

function armGate(): HydrationGate {
  let release!: () => void;
  const promise = new Promise<void>(r => {
    release = r;
  });
  const gate: HydrationGate = {
    promise,
    settled: false,
    resolve: () => {
      gate.settled = true;
      release();
    },
  };
  return gate;
}

export function PatientProvider({ children }: { children: ReactNode }) {
  const { resolving, account, accountNotice, retryResolve } = usePatientAccount();
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;

  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<PersistedState>(EMPTY_STATE);
  const stateRef = useRef<PersistedState>(EMPTY_STATE);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);

  // Bumped whenever the active account changes (and pinned alongside the
  // account it belongs to). Every async continuation captures the epoch it
  // started under and goes quiet if the account changed underneath it, so
  // one account's in-flight work can never land in another account's data.
  const epochRef = useRef(0);
  const runAccountRef = useRef<PatientAccount>({ kind: 'demo' });
  const startedKeyRef = useRef<string | null>(null);
  /**
   * True once the CURRENT account's state is authoritative: always for the
   * demo persona (local truth), and for a real account only after a
   * hydration actually delivered server state. While false, real-account
   * writes are blocked — a mutation computed from the empty fallback state
   * would overwrite the account's real server data (e.g. a favorites toggle
   * replaces the whole list).
   */
  const serverTruthRef = useRef(true);
  const [rehydrateTick, setRehydrateTick] = useState(0);

  // Deferred photo removals awaiting their server commit (real accounts
  // only), keyed by photo id. Each entry carries the provider-owned
  // backstop timer that commits the delete if the Progress screen — which
  // normally drives the commit — goes away mid-undo-window. Whoever commits
  // first claims the entry; everyone else no-ops. Cleared on account switch.
  const pendingPhotoRemovalsRef = useRef(
    new Map<string, { removed: RemovedProgressPhoto; timer: ReturnType<typeof setTimeout> }>(),
  );
  const commitPhotoRemovalRef = useRef<((removed: RemovedProgressPhoto) => Promise<void>) | null>(
    null,
  );
  // Onboarding flag saves queue here until server truth allows the push,
  // and survive a failed push for the notice's RETRY. Cleared on account
  // switch — queued flags belong to the account that produced them.
  const pendingFlagsRef = useRef<Partial<PatientFlagsWrite> | null>(null);
  const flagsFlightRef = useRef(false);
  const completionWaitersRef = useRef<Array<(saved: boolean) => void>>([]);
  // The account key the pending queues currently belong to (hygiene gate).
  const hygieneKeyRef = useRef<string | null>(null);
  // Onboarding answers/prefs as hydrated from the account, for
  // OnboardingProvider to reconcile from (demo persona: always null).
  const [hydratedFlags, setHydratedFlags] = useState<HydratedOnboardingFlags | null>(null);
  const [entryFacts, setEntryFacts] = useState<PatientEntryFacts | null>(null);
  const [profile, setProfile] = useState<PatientProfile | null>(null);

  // Mutations must wait for hydration: a pre-hydration commit would build on
  // EMPTY_STATE and clobber previously persisted data in storage.
  const hydrationGate = useRef<HydrationGate | null>(null);
  if (!hydrationGate.current) {
    hydrationGate.current = armGate();
  }

  const commit = useCallback(async (next: PersistedState, run: MutationRun): Promise<void> => {
    if (run.epoch !== epochRef.current) return;
    stateRef.current = next;
    setState(next);
    const payload = run.account.kind === 'real' ? localOnlySlice(next) : next;
    await writePersistedState(payload, storageKeyFor(run.account));
  }, []);

  /**
   * Opens a mutation run for the account generation the caller captured
   * right after its gate await. Returns null — mutation drops silently —
   * when the account switched while the mutation was queued, or if a stale
   * gate let it through before the current account finished hydrating.
   */
  const beginRun = useCallback((startEpoch: number): MutationRun | null => {
    const gate = hydrationGate.current;
    if (!gate?.settled || epochRef.current !== startEpoch) return null;
    return { epoch: startEpoch, account: runAccountRef.current };
  }, []);

  /**
   * Blocks user-gesture writes while the account lookup is unresolved, or —
   * for a real account — while no hydration has delivered server truth yet
   * (see serverTruthRef).
   */
  const requireWritableAccount = useCallback((run: MutationRun): boolean => {
    if (run.account.kind === 'unresolved') {
      setSyncNotice({ message: ACCOUNT_BLOCKED_MESSAGE, action: 'retry-account' });
      return false;
    }
    if (run.account.kind === 'real' && !serverTruthRef.current) {
      setSyncNotice({ message: DIARY_BLOCKED_MESSAGE, action: 'retry-hydration' });
      return false;
    }
    return true;
  }, []);

  /**
   * Real-account write path: optimistic local commit, then the server write;
   * on failure the optimistic commit is rolled back and the error surfaces
   * in the sync notice. Runs inside the serialized mutation chain, so the
   * rollback restores exactly the state this mutation started from.
   * Returns false when the write did not land.
   */
  const commitWithServer = useCallback(
    async (
      run: MutationRun,
      prev: PersistedState,
      next: PersistedState,
      op: (api: PatientDataApi) => Promise<void>,
    ): Promise<boolean> => {
      if (run.account.kind !== 'real') {
        // Only 'unresolved' reaches here (demo branches commit locally):
        // block loudly — a local-only save would strand data somewhere no
        // future sign-in could see.
        setSyncNotice({ message: ACCOUNT_BLOCKED_MESSAGE, action: 'retry-account' });
        return false;
      }
      if (!serverTruthRef.current) {
        // Belt-and-suspenders behind requireWritableAccount: never let a
        // write built on non-authoritative (empty) state reach the server.
        setSyncNotice({ message: DIARY_BLOCKED_MESSAGE, action: 'retry-hydration' });
        return false;
      }
      await commit(next, run);
      try {
        await op(run.account.api);
        return true;
      } catch (error) {
        if (epochRef.current === run.epoch) {
          await commit(prev, run);
          setSyncNotice({
            message:
              error instanceof Error && error.message ? error.message : WRITE_FAILED_MESSAGE,
            action: 'dismiss',
          });
        }
        return false;
      }
    },
    [commit],
  );

  /**
   * Drains the queued onboarding flag saves once the hydration gate opens
   * AND server truth is present. Single-flight; the loop picks up anything
   * queued while a push was in the air. On failure the payload goes back
   * into the queue (newer fields win) and a retryable notice surfaces — the
   * answers are never silently dropped.
   */
  const flushOnboardingFlags = useCallback(async (): Promise<void> => {
    if (flagsFlightRef.current) return;
    flagsFlightRef.current = true;
    try {
      while (pendingFlagsRef.current) {
        await hydrationGate.current!.promise;
        const run = beginRun(epochRef.current);
        if (!run) {
          completionWaitersRef.current.splice(0).forEach(resolve => resolve(false));
          return; // account switching underneath — switch clears the queue
        }
        if (run.account.kind !== 'real') {
          // Demo/unresolved: nothing to persist server-side.
          pendingFlagsRef.current = null;
          completionWaitersRef.current.splice(0).forEach(resolve => resolve(false));
          return;
        }
        if (!serverTruthRef.current) {
          // Blocked: hydration failed, its retry notice is already up. The
          // queue survives; a successful (re)hydration flushes it.
          completionWaitersRef.current.splice(0).forEach(resolve => resolve(false));
          return;
        }
        const payload = pendingFlagsRef.current;
        pendingFlagsRef.current = null;
        try {
          await run.account.api.writeFlags(payload);
          if (epochRef.current === run.epoch) {
            setHydratedFlags(previous => {
              if (!previous) return previous;
              return {
                ...previous,
                ...(payload.onboardingComplete !== undefined
                  ? { onboardingComplete: payload.onboardingComplete }
                  : {}),
                ...(payload.onboardingAnswers !== undefined
                  ? { onboardingAnswers: payload.onboardingAnswers as Record<string, unknown> }
                  : {}),
                ...(payload.notificationPrefs !== undefined
                  ? { notificationPrefs: payload.notificationPrefs as Record<string, unknown> }
                  : {}),
              };
            });
          }
        } catch (error) {
          if (epochRef.current === run.epoch) {
            pendingFlagsRef.current = { ...payload, ...(pendingFlagsRef.current ?? {}) };
            setSyncNotice({
              message:
                error instanceof Error && error.message ? error.message : WRITE_FAILED_MESSAGE,
              action: 'retry-flags',
            });
          }
          completionWaitersRef.current.splice(0).forEach(resolve => resolve(false));
          return;
        }
      }
      completionWaitersRef.current.splice(0).forEach(resolve => resolve(true));
    } finally {
      flagsFlightRef.current = false;
    }
  }, [beginRun]);

  const saveOnboardingFlags = useCallback(
    (flags: Partial<PatientFlagsWrite>) => {
      pendingFlagsRef.current = { ...(pendingFlagsRef.current ?? {}), ...flags };
      void flushOnboardingFlags();
    },
    [flushOnboardingFlags],
  );

  const completeOnboarding = useCallback(
    (
      flags: Partial<PatientFlagsWrite> & { onboardingComplete: true },
    ): Promise<boolean> => {
      if (runAccountRef.current.kind !== 'real') return Promise.resolve(true);
      pendingFlagsRef.current = { ...(pendingFlagsRef.current ?? {}), ...flags };
      const saved = new Promise<boolean>(resolve => {
        completionWaitersRef.current.push(resolve);
      });
      void flushOnboardingFlags();
      return saved;
    },
    [flushOnboardingFlags],
  );

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
    if (resolving) {
      // A retry of a failed account lookup is the one case where the same
      // account key must hydrate again when resolution settles.
      if (startedKeyRef.current === 'unresolved') startedKeyRef.current = null;
      return;
    }
    if (startedKeyRef.current === accountKey) return;
    const isInitialMount = epochRef.current === 0;
    startedKeyRef.current = accountKey;
    epochRef.current += 1;
    const epoch = epochRef.current;
    runAccountRef.current = account;
    // A real account has no authoritative state until its hydration lands.
    serverTruthRef.current = account.kind !== 'real';
    // Cross-account hygiene: pending deferred deletes and queued flag saves
    // belong to the account that created them — never let them fire into a
    // different account's data. A same-account rehydrate (the notice's
    // RETRY) keeps them: queued flags specifically wait out that retry.
    if (hygieneKeyRef.current !== accountKey) {
      hygieneKeyRef.current = accountKey;
      for (const pending of pendingPhotoRemovalsRef.current.values()) clearTimeout(pending.timer);
      pendingPhotoRemovalsRef.current.clear();
      pendingFlagsRef.current = null;
      completionWaitersRef.current.splice(0).forEach(resolve => resolve(false));
      // The media read token belongs to the previous account; the new
      // account's own token arrives with its hydration (demo never has one).
      setPatientMediaToken(null);
      setHydratedFlags(null);
      setEntryFacts(null);
      setProfile(null);
    }

    if (!isInitialMount) {
      // Account switched (or a hydration retry): drop the previous account's
      // in-memory data immediately and close the mutation gate until the new
      // hydration lands, so no account ever reads or writes another's slice.
      stateRef.current = EMPTY_STATE;
      setState(EMPTY_STATE);
      setHydrated(false);
      setSyncNotice(null);
      hydrationGate.current?.resolve(); // release any stragglers; beginRun drops them
      hydrationGate.current = armGate();
    }

    const finish = (nextState: PersistedState | null) => {
      if (epochRef.current !== epoch) return;
      if (nextState) {
        stateRef.current = nextState;
        setState(nextState);
      }
      setHydrated(true);
      hydrationGate.current?.resolve();
    };

    if (account.kind === 'real') {
      const acct = account;
      (async () => {
        const currentLocalDay = localTodayKey();
        const [serverResult, profileResult, localResult] = await Promise.allSettled([
          // Real accounts are not bounded by the demo seed calendar. The API
          // caps returned rows, while this unbounded range ensures every
          // program date Today exposes has its corresponding diary data.
          acct.api.fetchState(undefined, undefined, currentLocalDay),
          // Older injected test APIs predate the canonical profile rail.
          // Production patientDataApi always provides it.
          typeof acct.api.fetchProfile === 'function'
            ? acct.api.fetchProfile()
            : Promise.resolve(null),
          readPersistedState(storageKeyFor(acct)),
        ]);
        if (epochRef.current !== epoch) return;
        let local: PersistedState = EMPTY_STATE;
        if (localResult.status === 'fulfilled' && localResult.value) {
          try {
            local = localOnlySlice({
              ...EMPTY_STATE,
              ...(JSON.parse(localResult.value) as Partial<PersistedState>),
            });
          } catch {
            // corrupt local cache — start clean
          }
        }
        if (serverResult.status === 'fulfilled' && profileResult.status === 'fulfilled') {
          const server = serverResult.value;
          serverTruthRef.current = true;
          // Server truth just arrived — release any onboarding flag saves
          // that queued up while writes were still blocked.
          if (pendingFlagsRef.current) void flushOnboardingFlags();
          finish({
            ...local,
            addedEntries: server.entries,
            removedEntryIds: [],
            waterOverrides: server.water,
            targetOverrides: server.targets,
            favorites: server.favorites,
            recents: server.recents,
            customFoods: server.customFoods,
            savedRecipes: server.savedRecipes,
            addedCheckIns: server.checkIns,
            photos: server.photos.map(photoFromWire),
            nudgeOptOut: server.flags.nudgeOptOut,
            nudgeEngaged: server.flags.nudgeEngaged,
            nudgeLastSentKey: server.flags.nudgeLastSentKey,
            nudgeLastCrossingKey: server.flags.nudgeLastCrossingKey,
          });
          // Onboarding truth for OnboardingProvider — answers and prefs
          // are its state, not the diary's.
          setHydratedFlags({
            onboardingAnswers: server.flags.onboardingAnswers ?? null,
            notificationPrefs: server.flags.notificationPrefs ?? null,
            onboardingComplete: server.flags.onboardingComplete,
          });
          setEntryFacts(server.entry);
          setProfile(profileResult.value);
        } else {
          const failure =
            serverResult.status === 'rejected'
              ? serverResult.reason
              : profileResult.status === 'rejected'
                ? profileResult.reason
                : undefined;
          // Explicit failure: open seedless with the device-local slices and
          // surface the error with a retry. Server truth never arrived, so
          // writes stay BLOCKED (serverTruthRef) until a retry hydrates —
          // otherwise a mutation computed from this empty state could
          // overwrite the account's real server data.
          setSyncNotice({
            message:
              failure instanceof Error && failure.message
                ? failure.message
                : HYDRATE_FAILED_MESSAGE,
            action: 'retry-hydration',
          });
          finish(local);
        }
      })();
    } else if (account.kind === 'unresolved') {
      // Signed in but unidentifiable: stay seedless and empty; writes are
      // blocked with a retry notice (see requireWritableAccount).
      setSyncNotice({
        message: accountNotice ?? ACCOUNT_FAILED_MESSAGE,
        action: 'retry-account',
      });
      finish(null);
    } else {
      // Demo persona — the pre-live behavior, unchanged: seed constants plus
      // this device's locally persisted layer.
      readPersistedState(STORAGE_KEY)
        .then(raw => {
          if (epochRef.current !== epoch) return;
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
          if (epochRef.current !== epoch) return;
          setHydrated(true);
          hydrationGate.current?.resolve();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, resolving, rehydrateTick]);

  /** Re-runs the live hydration for the current account (sync notice RETRY). */
  const rehydrate = useCallback(() => {
    startedKeyRef.current = null;
    setRehydrateTick(t => t + 1);
  }, []);

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const addEntry = useCallback(async (entry: Omit<MealLogEntry, 'id'>): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const full: MealLogEntry = { ...entry, id: makeId(run, 'log') };
      const recents = entry.refId
        ? [entry.refId, ...prev.recents.filter(r => r !== entry.refId)].slice(0, 12)
        : prev.recents;
      const next = { ...prev, addedEntries: [...prev.addedEntries, full], recents };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api =>
        api.writeEntries({
          upsert: [full],
          ...(recents !== prev.recents ? { recents } : {}),
        }),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Copies already-logged entries (seeded or user-added, from any day) onto a
  // target day — optionally into one meal slot — as user-added entries with
  // fresh ids. Clones keep each source's logged snapshot rather than current
  // library values, and the whole batch lands in a single commit so day
  // totals update and persist atomically. Recents are left alone: copying a
  // day is repetition, not a new food choice. Returns the created clones —
  // captured inside the serialized mutation, so they are exactly what this
  // copy committed — letting the caller arm an Undo for just this batch.
  // In real-account mode a failed server write returns [] (no Undo to arm).
  const copyEntries = useCallback(async (sources: MealLogEntry[], target: { dateKey: string; meal?: MealSlot }): Promise<MealLogEntry[]> => {
    if (sources.length === 0) return [];
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return [];
      const prev = stateRef.current;
      const clones = cloneEntriesForCopy(sources, target, () => makeId(run, 'log'));
      const next = { ...prev, addedEntries: [...prev.addedEntries, ...clones] };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return clones;
      }
      const saved = await commitWithServer(run, prev, next, api =>
        api.writeEntries({ upsert: clones }),
      );
      return saved ? clones : [];
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // The "Yesterday's [meal]" review confirm — one commit that lands the kept
  // yesterday entries as snapshot-preserving copies (same rules as
  // copyEntries above) plus the review's search-added extras as fresh adds.
  // Recents split the difference deliberately: copied sources are repetition
  // and leave recents alone, while extras are new food choices and bump the
  // recents list exactly like addEntry would. Returns the whole created
  // batch — captured inside the serialized mutation — so the caller can arm
  // an Undo that takes back precisely this confirm.
  // In real-account mode a failed server write returns [] (no Undo to arm).
  const copyEntriesWithExtras = useCallback(async (
    sources: MealLogEntry[],
    extras: Array<Omit<MealLogEntry, 'id'>>,
    target: { dateKey: string; meal: MealSlot },
  ): Promise<MealLogEntry[]> => {
    if (sources.length === 0 && extras.length === 0) return [];
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return [];
      const prev = stateRef.current;
      const batch = buildCopyWithExtras(sources, extras, target, () => makeId(run, 'log'));
      const extraRefIds = [...new Set(
        extras.map(extra => extra.refId).filter((refId): refId is string => Boolean(refId)),
      )];
      const recents = extraRefIds.length > 0
        ? [...extraRefIds, ...prev.recents.filter(r => !extraRefIds.includes(r))].slice(0, 12)
        : prev.recents;
      const next = { ...prev, addedEntries: [...prev.addedEntries, ...batch], recents };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return batch;
      }
      const saved = await commitWithServer(run, prev, next, api =>
        api.writeEntries({
          upsert: batch,
          ...(recents !== prev.recents ? { recents } : {}),
        }),
      );
      return saved ? batch : [];
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  const removeEntry = useCallback(async (id: string): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const isReal = run.account.kind === 'real';
      const prev = stateRef.current;
      const next = applyRemoveEntry(prev, id, isReal ? neverSeedEntryId : isSeedEntryId);
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // nothing to delete (e.g. the second tap of a double-tapped remove)
      }
      if (!isReal) {
        await commit({ ...prev, ...next }, run);
        return;
      }
      await commitWithServer(run, prev, { ...prev, ...next }, api =>
        api.writeEntries({ deleteIds: [id] }),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

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
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const isReal = run.account.kind === 'real';
      const prev = stateRef.current;
      const next = applyRemoveEntries(prev, ids, isReal ? neverSeedEntryId : isSeedEntryId);
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // nothing left to remove (e.g. a double-tapped copy Undo)
      }
      if (!isReal) {
        await commit({ ...prev, ...next }, run);
        return;
      }
      const kept = new Set(next.addedEntries.map(e => e.id));
      const removedIds = prev.addedEntries.map(e => e.id).filter(entryId => !kept.has(entryId));
      await commitWithServer(run, prev, { ...prev, ...next }, api =>
        api.writeEntries({ deleteIds: removedIds }),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

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
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const isReal = run.account.kind === 'real';
      const prev = stateRef.current;
      const next = applyRestoreEntries(prev, entries, isReal ? neverSeedEntryId : isSeedEntryId);
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // nothing to undo
      }
      if (!isReal) {
        await commit({ ...prev, ...next }, run);
        return;
      }
      const prevIds = new Set(prev.addedEntries.map(e => e.id));
      const restored = next.addedEntries.filter(e => !prevIds.has(e.id));
      await commitWithServer(run, prev, { ...prev, ...next }, api =>
        api.writeEntries({ upsert: restored }),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

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
  // a user entry with a fresh id. Real accounts have no seeds: every entry
  // is the patient's own row and updates in place under its original id.
  const updateEntry = useCallback(async (id: string, changes: EntryEditChanges): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const isReal = run.account.kind === 'real';
      const prev = stateRef.current;
      const next = applyUpdateEntry(
        prev,
        id,
        changes,
        isReal ? neverFindSeedEntry : findSeedEntry,
        () => makeId(run, 'log'),
      );
      if (next.addedEntries === prev.addedEntries && next.removedEntryIds === prev.removedEntryIds) {
        return; // unknown id, or an already-deleted/edited entry — nothing to change
      }
      if (!isReal) {
        await commit({ ...prev, ...next }, run);
        return;
      }
      const prevById = new Map(prev.addedEntries.map(e => [e.id, e]));
      const changedRows = next.addedEntries.filter(e => prevById.get(e.id) !== e);
      if (changedRows.length === 0) {
        await commit({ ...prev, ...next }, run);
        return;
      }
      await commitWithServer(run, prev, { ...prev, ...next }, api =>
        api.writeEntries({ upsert: changedRows }),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  const setWater = useCallback(async (dateKey: string, oz: number): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const clamped = Math.max(0, Math.min(200, Math.round(oz)));
      const next = { ...prev, waterOverrides: { ...prev.waterOverrides, [dateKey]: clamped } };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api => api.writeWater(dateKey, clamped));
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  const addCheckIn = useCallback(async (checkIn: Omit<CheckIn, 'id'>): Promise<boolean> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return false;
      const prev = stateRef.current;
      const full: CheckIn = { ...checkIn, id: makeId(run, 'ci') };
      const next = {
        ...prev,
        addedCheckIns: [...prev.addedCheckIns.filter(c => c.dateKey !== checkIn.dateKey), full],
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return true;
      }
      // The server keys check-ins by day too, so a same-day re-submit
      // replaces the row there exactly as the filter above replaces it here.
      return await commitWithServer(run, prev, next, api => api.writeCheckIn(full));
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  const addPhoto = useCallback(async (photo: {
    dateKey: string;
    label: string;
    uri?: string;
    objectPath?: string;
  }): Promise<boolean> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return false;
      const prev = stateRef.current;
      const full: ProgressPhoto = { id: makeId(run, 'photo'), source: 'user', ...photo };
      const next = { ...prev, photos: [...prev.photos, full] };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return true;
      }
      return await commitWithServer(run, prev, next, api =>
        api.writeProgressPhotos([photoWire(full)]),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Batch insert for the guided photo session: one commit, one haptic —
  // the whole set lands atomically so an interruption mid-save can never
  // leave a partial session in the grid.
  const addPhotos = useCallback(
    async (
      photos: Array<{
        dateKey: string;
        label: string;
        uri?: string;
        angle?: 'front' | 'side' | 'back';
        objectPath?: string;
      }>,
    ): Promise<boolean> => {
      if (photos.length === 0) return true;
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await hydrationGate.current!.promise;
      const startEpoch = epochRef.current;
      return await runSerialized(async () => {
        const run = beginRun(startEpoch);
        if (!run || !requireWritableAccount(run)) return false;
        const prev = stateRef.current;
        const full: ProgressPhoto[] = photos.map(photo => ({
          id: makeId(run, 'photo'),
          source: 'user' as const,
          ...photo,
        }));
        const next = { ...prev, photos: [...prev.photos, ...full] };
        if (run.account.kind !== 'real') {
          await commit(next, run);
          return true;
        }
        return await commitWithServer(run, prev, next, api =>
          api.writeProgressPhotos(full.map(photoWire)),
        );
      });
    },
    [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized],
  );

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
    const startEpoch = epochRef.current;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return null;
      const prev = stateRef.current;
      const removed = captureRemovedPhoto(prev.photos, id);
      const nextPhotos = applyRemovePhoto(prev.photos, id);
      if (nextPhotos !== prev.photos) {
        await commit({ ...prev, photos: nextPhotos }, run);
        if (removed && run.account.kind === 'real') {
          // Provider-owned backstop: the Progress screen normally commits
          // the server delete when its undo window lapses, but the screen
          // can unmount mid-window — this timer makes sure expiry still
          // reaches the server once no Undo can possibly be tappable.
          // unref (a no-op outside Node) keeps test scripts from hanging.
          const timer = setTimeout(() => {
            void commitPhotoRemovalRef.current?.(removed);
          }, PHOTO_REMOVAL_BACKSTOP_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
          pendingPhotoRemovalsRef.current.set(removed.photo.id, { removed, timer });
        }
      }
      return removed;
    });
  }, [beginRun, commit, requireWritableAccount, runSerialized]);

  // Undo for removePhoto. Re-inserts the exact snapshot under its original id
  // at its captured position. Only an actual recorded removal is undone: a
  // double-tapped Undo no-ops instead of inserting a duplicate (see
  // applyRestorePhoto).
  const restorePhoto = useCallback(async (removed: RemovedProgressPhoto): Promise<void> => {
    // Undo won: claim the pending server delete BEFORE anything yields, so
    // the backstop can no longer race this restore into the mutation chain.
    const pending = pendingPhotoRemovalsRef.current.get(removed.photo.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPhotoRemovalsRef.current.delete(removed.photo.id);
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const nextPhotos = applyRestorePhoto(prev.photos, removed);
      if (nextPhotos === prev.photos) {
        return; // nothing to undo
      }
      await commit({ ...prev, photos: nextPhotos }, run);
    });
  }, [beginRun, commit, requireWritableAccount, runSerialized]);

  // Second half of the deferred delete: the Progress screen calls this once
  // its undo window closes (or when a newer removal replaces the pending
  // one). Demo and unresolved accounts no-op — the local removal was the
  // whole job. For a real account this is the moment the server record and
  // the stored bytes actually go away; on failure the photo is rolled back
  // into the grid with a sync notice — better a resurfaced photo than a
  // grid row whose object is half-deleted.
  const commitPhotoRemoval = useCallback(async (removed: RemovedProgressPhoto): Promise<void> => {
    // Single-flight claim: whichever caller gets here first — the screen's
    // undo-window timer, the screen replacing a pending notice, or the
    // provider backstop after an unmount — takes the entry; everyone else
    // returns. Demo and unresolved accounts never register an entry, so
    // their local removal stays the whole job, exactly as before.
    const pending = pendingPhotoRemovalsRef.current.get(removed.photo.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPhotoRemovalsRef.current.delete(removed.photo.id);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind !== 'real') return;
      // Belt-and-suspenders: a removal can only have committed with server
      // truth present, but never send a delete built on non-authoritative
      // state.
      if (!serverTruthRef.current) return;
      const current = stateRef.current;
      // Undone (or already committed) meanwhile — nothing to delete.
      if (current.photos.some(p => p.id === removed.photo.id)) return;
      const withPhotoRestored = {
        ...current,
        photos: applyRestorePhoto(current.photos, removed),
      };
      await commitWithServer(run, withPhotoRestored, current, api =>
        api.removeProgressPhoto(removed.photo.id),
      );
    });
  }, [beginRun, commitWithServer, runSerialized]);
  // Latest-callback ref so backstop timers armed by older renders always
  // invoke the current commit (with its current epoch machinery).
  commitPhotoRemovalRef.current = commitPhotoRemoval;

  const toggleFavorite = useCallback(async (id: string): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const favorites = prev.favorites.includes(id)
        ? prev.favorites.filter(f => f !== id)
        : [...prev.favorites, id];
      const next = { ...prev, favorites };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api => api.writePrefs({ favorites }));
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  const addCustomFood = useCallback(async (food: Omit<FoodItem, 'id' | 'category'>): Promise<FoodItem> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      const prev = stateRef.current;
      const full: FoodItem = {
        ...food,
        id: run ? makeId(run, 'custom') : nextId('custom'),
        category: 'My Foods',
      };
      if (!run || !requireWritableAccount(run)) return full;
      const next = { ...prev, customFoods: [...prev.customFoods, full] };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return full;
      }
      await commitWithServer(run, prev, next, api => api.writeLibrary({ foodUpsert: [full] }));
      return full;
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Rebuilds the food from the payload (not a merge) so cleared optional
  // fields like brand actually drop. Diary entries are untouched: they
  // snapshot name/calories/macros at log time.
  const updateCustomFood = useCallback(async (id: string, food: Omit<FoodItem, 'id' | 'category'>): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const prevItem = prev.customFoods.find(f => f.id === id);
      const rebuilt: FoodItem = { ...food, id, category: 'My Foods' };
      if (run.account.kind === 'real') {
        if (rebuilt.photoUri && prevItem?.photoPath && rebuilt.photoUri === prevItem.photoUri) {
          // Unchanged display photo — keep its account reference riding along.
          rebuilt.photoPath = prevItem.photoPath;
        } else if (rebuilt.photoUri?.startsWith('data:')) {
          // A fresh local photo — move it onto the account rail. Best-effort:
          // the edit itself must not fail because a photo didn't land.
          try {
            const uploaded = await run.account.api.uploadLibraryPhoto('food', rebuilt.photoUri);
            rebuilt.photoPath = uploaded.photoPath;
            rebuilt.photoUri = uploaded.photoUri;
          } catch (error) {
            console.error('Custom food photo upload failed', error);
            delete rebuilt.photoUri;
            delete rebuilt.photoPath;
          }
        } else {
          // Photo cleared (or never uploaded) — drop any stale reference so
          // the server de-references the old object.
          delete rebuilt.photoPath;
        }
      }
      const next = {
        ...prev,
        customFoods: prev.customFoods.map(f => (f.id === id ? rebuilt : f)),
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      // Upserting an id the account doesn't know would CREATE it server-side;
      // an edit of a vanished food (double-fired form) simply drops.
      if (!prevItem) return;
      await commitWithServer(run, prev, next, api => api.writeLibrary({ foodUpsert: [rebuilt] }));
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Existing diary entries keep their logged values; only the library item
  // (plus any dangling favorite/recent references) goes away. Returns the
  // pre-removal snapshot — food, favorite and recents references with their
  // positions — so the caller can offer an Undo; the capture happens inside
  // the serialized mutation, so it reflects exactly what this delete
  // stripped. Returns null when the id isn't a custom food (double-tap).
  // For real accounts the food row, its photo reference, and any
  // favorite/recents references all live on the account — the whole removal
  // is ONE atomic server write and rolls back whole if that write fails.
  const removeCustomFood = useCallback(async (id: string): Promise<RemovedCustomFood | null> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return null;
      const prev = stateRef.current;
      const removed = captureRemovedCustomFood(prev, id);
      const next = applyRemoveCustomFood(prev, id);
      if (next === prev) {
        return removed;
      }
      const merged = { ...prev, ...next };
      if (run.account.kind !== 'real') {
        await commit(merged, run);
        return removed;
      }
      const saved = await commitWithServer(run, prev, merged, api =>
        api.writeLibrary({
          foodDeleteIds: [id],
          ...(merged.favorites !== prev.favorites ? { favorites: merged.favorites } : {}),
          ...(merged.recents !== prev.recents ? { recents: merged.recents } : {}),
        }),
      );
      return saved ? removed : null;
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Undo for removeCustomFood. Re-inserts the exact snapshot under its
  // original id and re-attaches the favorite/recents references the removal
  // stripped. Only an actual recorded deletion is undone: a double-tapped
  // Undo no-ops instead of inserting a duplicate (see applyRestoreCustomFood).
  const restoreCustomFood = useCallback(async (removed: RemovedCustomFood): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const next = applyRestoreCustomFood(prev, removed);
      if (next === prev) {
        return; // nothing to undo
      }
      const merged = { ...prev, ...next };
      if (run.account.kind !== 'real') {
        await commit(merged, run);
        return;
      }
      // removed.food still carries its photoPath, so the account re-registers
      // the photo alongside the row — Undo restores the photo reference too.
      await commitWithServer(run, prev, merged, api =>
        api.writeLibrary({
          foodUpsert: [removed.food],
          ...(merged.favorites !== prev.favorites ? { favorites: merged.favorites } : {}),
          ...(merged.recents !== prev.recents ? { recents: merged.recents } : {}),
        }),
      );
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Keeps an AI suggestion permanently (Library > Recipes). Stored whole —
  // demo keeps the generated photo data URI inline; real accounts move the
  // photo onto the account's media rail first so it follows the patient.
  const addSavedRecipe = useCallback(async (recipe: Omit<SavedRecipe, 'id'>): Promise<SavedRecipe> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      const prev = stateRef.current;
      const full: SavedRecipe = {
        ...recipe,
        id: run ? makeId(run, 'airec') : nextId('airec'),
      };
      if (!run || !requireWritableAccount(run)) return full;
      if (run.account.kind !== 'real') {
        await commit({ ...prev, savedRecipes: [...prev.savedRecipes, full] }, run);
        return full;
      }
      if (full.photoUri?.startsWith('data:')) {
        // Best-effort: the recipe itself must not fail because a photo
        // didn't land — it saves photo-less and the backfill can retry.
        try {
          const uploaded = await run.account.api.uploadLibraryPhoto('recipe', full.photoUri);
          full.photoPath = uploaded.photoPath;
          full.photoUri = uploaded.photoUri;
        } catch (error) {
          console.error('Saved recipe photo upload failed', error);
          delete full.photoUri;
        }
      }
      await commitWithServer(
        run,
        prev,
        { ...prev, savedRecipes: [...prev.savedRecipes, full] },
        api => api.writeLibrary({ recipeUpsert: [full] }),
      );
      return full;
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // Photo backfill for AI suggestions saved while their dish photo was still
  // generating: patch just the photo onto the already-persisted record. No
  // haptics — these fire programmatically when generation resolves, not from
  // a user gesture (and they skip silently while an account is unresolved).
  const setCustomFoodPhoto = useCallback(async (id: string, photoUri: string): Promise<void> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    const preRun = beginRun(startEpoch);
    if (!preRun || preRun.account.kind === 'unresolved') return;
    if (preRun.account.kind === 'real' && !serverTruthRef.current) return;
    if (!stateRef.current.customFoods.some(f => f.id === id)) return;
    let patch: Pick<FoodItem, 'photoUri' | 'photoPath'> = { photoUri };
    if (preRun.account.kind === 'real') {
      if (!photoUri.startsWith('data:')) return; // nothing uploadable
      try {
        patch = await preRun.account.api.uploadLibraryPhoto('food', photoUri);
      } catch (error) {
        // Quiet by design: a background photo patch never pops a snackbar.
        // The food stays photo-less; the backfill can try again later.
        console.error('Custom food photo upload failed', error);
        return;
      }
    }
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return;
      const prev = stateRef.current;
      const target = prev.customFoods.find(f => f.id === id);
      if (!target) return;
      const nextItem = { ...target, ...patch };
      const next = {
        ...prev,
        customFoods: prev.customFoods.map(f => (f.id === id ? nextItem : f)),
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api => api.writeLibrary({ foodUpsert: [nextItem] }));
    });
  }, [beginRun, commit, commitWithServer, runSerialized]);

  const setSavedRecipePhoto = useCallback(async (id: string, photoUri: string): Promise<void> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    const preRun = beginRun(startEpoch);
    if (!preRun || preRun.account.kind === 'unresolved') return;
    if (preRun.account.kind === 'real' && !serverTruthRef.current) return;
    if (!stateRef.current.savedRecipes.some(r => r.id === id)) return;
    let patch: Pick<SavedRecipe, 'photoUri' | 'photoPath'> = { photoUri };
    if (preRun.account.kind === 'real') {
      if (!photoUri.startsWith('data:')) return; // nothing uploadable
      try {
        patch = await preRun.account.api.uploadLibraryPhoto('recipe', photoUri);
      } catch (error) {
        console.error('Saved recipe photo upload failed', error);
        return;
      }
    }
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return;
      const prev = stateRef.current;
      const target = prev.savedRecipes.find(r => r.id === id);
      if (!target) return;
      const nextItem = { ...target, ...patch };
      const next = {
        ...prev,
        savedRecipes: prev.savedRecipes.map(r => (r.id === id ? nextItem : r)),
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api =>
        api.writeLibrary({ recipeUpsert: [nextItem] }),
      );
    });
  }, [beginRun, commit, commitWithServer, runSerialized]);

  const setTargets = useCallback(async (partial: Partial<DailyTargets>): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const next = { ...prev, targetOverrides: { ...prev.targetOverrides, ...partial } };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      const cleaned: Partial<DailyTargets> = {};
      for (const key of ['calories', 'protein', 'carbs', 'fat', 'waterOz'] as const) {
        const value = partial[key];
        if (typeof value === 'number' && Number.isFinite(value)) cleaned[key] = value;
      }
      if (Object.keys(cleaned).length === 0) {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api => api.writeTargets(cleaned));
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  const clearLocalState = useCallback(async (): Promise<void> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return;
      await commit({ ...EMPTY_STATE }, run);
    });
  }, [beginRun, commit, runSerialized]);

  // ─── Stall-nudge state ─────────────────────────────────────────────────────
  // (The assessment memo and recordNudgeSent live under Merged projections —
  // recordNudgeSent reads the computed crossing day.)

  // Any patient reply to the outreach — programmatic, so no haptics, and
  // idempotent so a burst of sends commits once.
  const markNudgeEngaged = useCallback(async (): Promise<void> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return;
      // Programmatic (no gesture to block): before server truth arrives,
      // skip silently rather than surface a notice the patient didn't cause.
      if (run.account.kind === 'real' && !serverTruthRef.current) return;
      const prev = stateRef.current;
      if (prev.nudgeEngaged) return;
      const next = { ...prev, nudgeEngaged: true };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api => api.writeFlags({ nudgeEngaged: true }));
    });
  }, [beginRun, commit, commitWithServer, runSerialized]);

  const setNudgeOptOut = useCallback(async (optOut: boolean): Promise<void> => {
    await Haptics.selectionAsync();
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      if (prev.nudgeOptOut === optOut) return;
      const next = { ...prev, nudgeOptOut: optOut };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api => api.writeFlags({ nudgeOptOut: optOut }));
    });
  }, [beginRun, commit, commitWithServer, requireWritableAccount, runSerialized]);

  // ─── Merged projections ────────────────────────────────────────────────────

  // Seeds belong to the demo persona only. While a live session is still
  // resolving they are withheld too, so a real patient never sees a flash of
  // the demo diary before their own loads.
  const seedsOn = !resolving && account.kind === 'demo';
  const seedEntries = seedsOn ? SEED_ENTRIES : NO_SEED_ENTRIES;
  const seedCheckIns = seedsOn ? SEED_CHECKINS : NO_SEED_CHECKINS;
  const seedPhotos = seedsOn ? SEED_PHOTOS : NO_SEED_PHOTOS;

  const targets = useMemo<DailyTargets>(
    () => ({ ...DEFAULT_TARGETS, ...state.targetOverrides }),
    [state.targetOverrides],
  );

  const allEntries = useMemo(() => {
    const removed = new Set(state.removedEntryIds);
    return [...seedEntries, ...state.addedEntries].filter(e => !removed.has(e.id));
  }, [state.removedEntryIds, state.addedEntries, seedEntries]);

  const entriesForDate = useCallback(
    (dateKey: string) => allEntries.filter(e => e.dateKey === dateKey),
    [allEntries],
  );

  const waterFor = useCallback(
    (dateKey: string) =>
      state.waterOverrides[dateKey] ?? (seedsOn ? SEED_WATER[dateKey] : undefined) ?? 0,
    [state.waterOverrides, seedsOn],
  );

  const checkIns = useMemo(() => {
    const userDates = new Set(state.addedCheckIns.map(c => c.dateKey));
    return [...seedCheckIns.filter(c => !userDates.has(c.dateKey)), ...state.addedCheckIns]
      .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  }, [state.addedCheckIns, seedCheckIns]);

  const checkInFor = useCallback(
    (dateKey: string) => checkIns.find(c => c.dateKey === dateKey),
    [checkIns],
  );

  const weightSeries = useMemo<WeightPoint[]>(() => {
    const byDate = new Map<string, number>();
    if (seedsOn) {
      // The demo profile's starting weight anchors the seeded series; a real
      // account's series is built purely from its own check-ins.
      byDate.set(toDateKey(new Date(PATIENT_PROFILE.startDate)), PATIENT_PROFILE.startingWeight);
    }
    [...checkIns]
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
      .forEach(c => {
        if (typeof c.weight === 'number') byDate.set(c.dateKey, c.weight);
      });
    return [...byDate.entries()]
      .map(([dateKey, weight]) => ({ dateKey, weight }))
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  }, [checkIns, seedsOn]);

  // Stall-nudge trigger: classified diary entries plus the weigh-in series,
  // assessed as of the demo anchor day. Recomputes as the patient logs, so
  // every surface (chat seeding, check-in note) reads one decision.
  const nudgeAssessment = useMemo<NudgeAssessment>(
    () => assessNudge(classifyEntries(allEntries), weightSeries, TODAY_KEY),
    [allEntries, weightSeries],
  );

  const shouldSeedNudgeOutreach = useMemo<boolean>(() => {
    if (!hydrated) return false;
    return shouldSeedOutreach(
      nudgeAssessment,
      {
        optOut: state.nudgeOptOut,
        engaged: state.nudgeEngaged,
        lastSentKey: state.nudgeLastSentKey,
        lastCrossingKey: state.nudgeLastCrossingKey,
      },
      TODAY_KEY,
    );
  }, [
    hydrated,
    nudgeAssessment,
    state.nudgeOptOut,
    state.nudgeEngaged,
    state.nudgeLastCrossingKey,
    state.nudgeLastSentKey,
  ]);

  // Below the assessment memo it reads. Fires when the chat seeds the
  // outreach — programmatic, so no haptics.
  const recordNudgeSent = useCallback(async (): Promise<void> => {
    const crossing = nudgeAssessment.crossedOnKey;
    if (crossing === null) return;
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return;
      // Programmatic — skip silently before server truth (see markNudgeEngaged).
      if (run.account.kind === 'real' && !serverTruthRef.current) return;
      const prev = stateRef.current;
      // Idempotent per episode: only the first stamp anchors the cooldown.
      if (prev.nudgeLastCrossingKey === crossing && prev.nudgeLastSentKey !== null) return;
      const next = {
        ...prev,
        nudgeLastSentKey: TODAY_KEY,
        nudgeLastCrossingKey: crossing,
        // A fresh episode starts unengaged even if an older one was answered.
        nudgeEngaged: false,
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitWithServer(run, prev, next, api =>
        api.writeFlags({
          nudgeLastSentKey: TODAY_KEY,
          nudgeLastCrossingKey: crossing,
          nudgeEngaged: false,
        }),
      );
    });
  }, [beginRun, commit, commitWithServer, runSerialized, nudgeAssessment]);

  // Stable ascending sort: equal dateKeys keep concatenation order (seeds
  // first, then user photos in add order), so two photos added the same day
  // display oldest-first and their de-duplicated "Week N (2)" counters read
  // in the order they were added.
  const photos = useMemo(
    () =>
      [...seedPhotos, ...state.photos].sort((a, b) =>
        a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0,
      ),
    [state.photos, seedPhotos],
  );

  const applyProfile = useCallback((next: PatientProfile) => {
    setProfile(next);
    setEntryFacts(previous => {
      if (!previous) return previous;
      const today = new Date(`${previous.todayKey}T12:00:00Z`).getTime();
      const start = next.programStartDate
        ? new Date(`${next.programStartDate}T12:00:00Z`).getTime()
        : Number.NaN;
      const programDay = Number.isFinite(start)
        ? Math.max(1, Math.floor((today - start) / 86_400_000) + 1)
        : previous.programDay;
      return {
        ...previous,
        firstName: next.firstName || previous.firstName,
        programStartDate: next.programStartDate ?? previous.programStartDate,
        programDay,
      };
    });
  }, []);

  const saveProfile = useCallback(
    async (partial: PatientProfileWrite): Promise<boolean> => {
      const run = runAccountRef.current;
      if (run.kind !== 'real' || !serverTruthRef.current) {
        setSyncNotice({
          message: run.kind === 'unresolved' ? ACCOUNT_BLOCKED_MESSAGE : DIARY_BLOCKED_MESSAGE,
          action: run.kind === 'unresolved' ? 'retry-account' : 'retry-hydration',
        });
        return false;
      }
      try {
        const result = await run.api.writeProfile(partial);
        applyProfile(result.profile);
        return true;
      } catch (error) {
        setSyncNotice({
          message: error instanceof Error && error.message ? error.message : WRITE_FAILED_MESSAGE,
          action: 'dismiss',
        });
        return false;
      }
    },
    [hydratedFlags, applyProfile],
  );

  const saveSetup = useCallback(
    async (input: { profile: PatientProfileWrite; onboardingAnswers: object }): Promise<boolean> => {
      const run = runAccountRef.current;
      if (run.kind !== 'real' || !serverTruthRef.current) return false;
      try {
        const result = await run.api.saveSetup(input);
        applyProfile(result.profile);
        setHydratedFlags(previous => ({
          onboardingAnswers: input.onboardingAnswers as Record<string, unknown>,
          notificationPrefs: previous?.notificationPrefs ?? null,
          onboardingComplete: previous?.onboardingComplete === true,
        }));
        return true;
      } catch (error) {
        setSyncNotice({
          message: error instanceof Error && error.message ? error.message : WRITE_FAILED_MESSAGE,
          action: 'dismiss',
        });
        return false;
      }
    },
    [applyProfile],
  );

  const completeSetup = useCallback(
    async (input: {
      profile: PatientSetupWrite;
      onboardingAnswers: object;
      notificationPrefs: object;
    }): Promise<boolean> => {
      const run = runAccountRef.current;
      if (run.kind !== 'real' || !serverTruthRef.current) return false;
      try {
        const result = await run.api.completeSetup(input);
        applyProfile(result.profile);
        setHydratedFlags({
          onboardingAnswers: input.onboardingAnswers as Record<string, unknown>,
          notificationPrefs: input.notificationPrefs as Record<string, unknown>,
          onboardingComplete: true,
        });
        return true;
      } catch (error) {
        setSyncNotice({
          message: error instanceof Error && error.message ? error.message : WRITE_FAILED_MESSAGE,
          action: 'dismiss',
        });
        return false;
      }
    },
    [applyProfile],
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
      copyEntriesWithExtras,
      removeEntry,
      removeEntries,
      restoreEntry,
      restoreEntries,
      updateEntry,
      setWater,
      addCheckIn,
      addPhoto,
      addPhotos,
      removePhoto,
      restorePhoto,
      commitPhotoRemoval,
      toggleFavorite,
      addCustomFood,
      updateCustomFood,
      removeCustomFood,
      restoreCustomFood,
      addSavedRecipe,
      setCustomFoodPhoto,
      setSavedRecipePhoto,
      setTargets,
      nudgeAssessment,
      nudgeOptOut: state.nudgeOptOut,
      nudgeEngaged: state.nudgeEngaged,
      shouldSeedNudgeOutreach,
      markNudgeEngaged,
      setNudgeOptOut,
      recordNudgeSent,
      saveOnboardingFlags,
      completeOnboarding,
      hydratedFlags,
      entryFacts,
      profile,
      saveProfile,
      applyProfile,
      saveSetup,
      completeSetup,
      clearLocalState,
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
      copyEntriesWithExtras,
      removeEntry,
      removeEntries,
      restoreEntry,
      restoreEntries,
      updateEntry,
      setWater,
      addCheckIn,
      addPhoto,
      addPhotos,
      removePhoto,
      restorePhoto,
      commitPhotoRemoval,
      toggleFavorite,
      addCustomFood,
      updateCustomFood,
      removeCustomFood,
      restoreCustomFood,
      addSavedRecipe,
      setCustomFoodPhoto,
      setSavedRecipePhoto,
      setTargets,
      nudgeAssessment,
      state.nudgeOptOut,
      state.nudgeEngaged,
      shouldSeedNudgeOutreach,
      markNudgeEngaged,
      setNudgeOptOut,
      recordNudgeSent,
      saveOnboardingFlags,
      completeOnboarding,
      hydratedFlags,
      entryFacts,
      profile,
      saveProfile,
      applyProfile,
      saveSetup,
      completeSetup,
      clearLocalState,
    ],
  );

  const noticeValue = useMemo<PatientSyncNoticeValue | null>(() => {
    if (!syncNotice) return null;
    const notice = syncNotice;
    return {
      message: notice.message,
      actionLabel: notice.action === 'dismiss' ? 'OK' : 'RETRY',
      onAction: () => {
        setSyncNotice(null);
        if (notice.action === 'retry-account') retryResolve();
        else if (notice.action === 'retry-hydration') rehydrate();
        else if (notice.action === 'retry-flags') void flushOnboardingFlags();
      },
    };
  }, [syncNotice, retryResolve, rehydrate, flushOnboardingFlags]);

  return (
    <PatientContext.Provider value={value}>
      <PatientSyncNoticeContext.Provider value={noticeValue}>
        {children}
      </PatientSyncNoticeContext.Provider>
    </PatientContext.Provider>
  );
}

export function usePatient() {
  const ctx = useContext(PatientContext);
  if (!ctx) throw new Error('usePatient must be used within PatientProvider');
  return ctx;
}

/**
 * Like usePatient, but tolerates rendering outside PatientProvider (returns
 * null there). For contexts that are also mounted standalone in Node suites
 * — e.g. OnboardingProvider — where a missing patient store simply means
 * "nowhere to persist", not a wiring bug.
 */
export function usePatientOptional() {
  return useContext(PatientContext);
}

/** Read by components/patient/PatientSyncNotice.tsx (root layout). */
export function usePatientSyncNotice(): PatientSyncNoticeValue | null {
  return useContext(PatientSyncNoticeContext);
}
