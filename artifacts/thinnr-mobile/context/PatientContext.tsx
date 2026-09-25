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
import { AppState, Platform } from 'react-native';
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
import { takeSignupSeed } from '@/lib/signup-seed';
import type { PrivacyState } from '@/lib/patient-privacy';
import { PatientDataError } from '@/lib/patient-data-error';
import { newUuid } from '@/lib/uuid';
import {
  validateMedicationInput,
  type DoseLogRecord,
  type MedicationInput,
  type MedicationRecord,
} from '@/lib/medication-schedule';
import type { DoseLogWrite } from '@/context/PatientAccountContext';
import { isOnline, subscribeConnectivity } from '@/lib/connectivity';
import {
  SYNC_CHIP_TUNING,
  backoffDelay,
  deriveSyncStatus,
  markAttemptFailed,
  markRetryRequested,
  parseQueue,
  pendingEntityKeys,
  projectQueue,
  projectWrite,
  reconcileQueue,
  serializeQueue,
  type QueuedWrite,
  type QueuedWritePayload,
  type SyncStatus,
} from '@/lib/patient-write-queue';
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
  parseNutritionSnapshot,
  scaledSnapshotMacros,
  snapshotConfigurationId,
} from '@/data/food-nutrition';
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
  type PatientServerState,
  type PatientSetupWrite,
  type ProgressPhotoWire,
} from './PatientAccountContext';

const STORAGE_KEY = 'thinnr_patient_state_v1';
// Offline write queue, per real account (see lib/patient-write-queue.ts).
const queueKeyFor = (patientId: string) => `${STORAGE_KEY}:queue_${patientId}`;
// Last server-confirmed snapshot (plus acked queue items), per real account:
// what the diary opens on when a launch can't reach the server.
const snapshotKeyFor = (patientId: string) => `${STORAGE_KEY}:snapshot_${patientId}`;
// A photo captured offline keeps its bytes out of the queue file.
const blobKeyFor = (itemId: string) => `${STORAGE_KEY}:blob_${itemId}`;

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
  await writePersistedRaw(key, JSON.stringify(next));
}

async function writePersistedRaw(key: string, serialized: string): Promise<void> {
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

async function removePersisted(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await AsyncStorage.removeItem(key);
}

interface PersistedState {
  addedEntries: MealLogEntry[];
  removedEntryIds: string[];
  waterOverrides: Record<string, number>;
  addedCheckIns: CheckIn[];
  /** The account's medication list and trailing dose decisions (server-backed; empty for the demo persona). */
  medications: MedicationRecord[];
  doseLogs: DoseLogRecord[];
  photos: ProgressPhoto[];
  favorites: string[];
  customFoods: FoodItem[];
  /** Private snapshots of selected shared foods, retained for offline reuse. */
  catalogFoods: FoodItem[];
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
  medications: [],
  doseLogs: [],
  photos: [],
  favorites: [],
  customFoods: [],
  catalogFoods: [],
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
function localOnlySlice(state: PersistedState): PersistedState {
  return { ...EMPTY_STATE };
}

/** Server truth → the base every queued write projects on top of. */
function baseFromServer(server: PatientServerState): PersistedState {
  return {
    ...EMPTY_STATE,
    addedEntries: server.entries,
    removedEntryIds: [],
    waterOverrides: server.water,
    targetOverrides: server.targets,
    favorites: server.favorites,
    recents: server.recents,
    customFoods: server.customFoods,
    catalogFoods: server.catalogFoods ?? [],
    savedRecipes: server.savedRecipes,
    addedCheckIns: server.checkIns,
    medications: server.medications,
    doseLogs: server.doseLogs,
    photos: server.photos.map(photoFromWire),
    nudgeOptOut: server.flags.nudgeOptOut,
    nudgeEngaged: server.flags.nudgeEngaged,
    nudgeLastSentKey: server.flags.nudgeLastSentKey,
    nudgeLastCrossingKey: server.flags.nudgeLastCrossingKey,
  };
}

/** Medication record → the write shape (source/version are server-owned). */
function medicationInputOf(record: MedicationRecord): MedicationInput {
  const { source: _source, version: _version, ...input } = record;
  return input;
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
  catalogFoods: FoodItem[];
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
  /**
   * Food-search batch submission with an honest acceptance receipt. Real
   * accounts resolve as queued (not confirmed) and retain the immutable rows
   * under queueId for retry; demo resolves as locally saved.
   */
  submitFoodEntries: (
    entries: Array<Omit<MealLogEntry, 'id'>>,
  ) => Promise<FoodSubmissionReceipt>;
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
  /** The account's medication list (every record, stopped ones included) and trailing dose decisions. */
  medications: MedicationRecord[];
  doseLogs: DoseLogRecord[];
  /**
   * Creates (no id) or replaces (id) one medication. Resolves the saved
   * record, or null when the input was invalid (message in `error`) or the
   * account write failed (sync notice posted).
   */
  saveMedication: (
    input: Omit<MedicationInput, 'id'> & { id?: string },
  ) => Promise<{ medication: MedicationRecord } | { error: string; field: string | null }>;
  /**
   * Records one dose decision for a scheduled occurrence (null clears it).
   * Same truth contract as addCheckIn: true only when safely recorded.
   */
  logDose: (input: Omit<DoseLogWrite, 'id'>) => Promise<boolean>;
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
      /** Upload id a deferred guided shot already used, so its queued upload re-uses the same object. */
      uploadId?: string;
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
  /** Persist a private, immutable lookup snapshot for a shared food selection. */
  saveCatalogFood: (food: FoodItem) => Promise<boolean>;
  /** Save the shown exact configuration and optionally set its favorite state atomically. */
  saveFoodConfiguration: (
    food: FoodItem,
    options?: { favorite?: boolean },
  ) => Promise<FoodItem | null>;
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
  /**
   * Consent, export, and deletion state exactly as the account's hydration
   * delivered it — null before a real hydration and always null for the demo
   * persona. The route gate reads consent from here; the account and consent
   * screens replace it after each privacy write via applyPrivacy.
   */
  hydratedPrivacy: PrivacyState | null;
  applyPrivacy: (next: PrivacyState | ((previous: PrivacyState | null) => PrivacyState | null)) => void;
  /**
   * Re-runs the live hydration for the current account. The consent screen
   * calls it after recording consent: the server refused the data slice
   * until then (CONSENT_REQUIRED), so the account still has no diary,
   * flags, or profile in memory.
   */
  rehydrate: () => void;
  /**
   * Canonical "today" for every patient surface. The demo persona pins the
   * seeded anchor (TODAY_KEY) so seeded suites stay byte-identical; a real
   * account rides the device's local calendar day, recomputed on foreground
   * and at local midnight. Screens and mutations must read this instead of
   * importing TODAY_KEY directly.
   */
  todayKey: string;
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

export type FoodSubmissionReceipt =
  | { outcome: 'locally_saved_demo'; entries: MealLogEntry[] }
  | { outcome: 'queued'; queueId: string; entries: MealLogEntry[] }
  | { outcome: 'server_confirmed'; entries: MealLogEntry[] }
  | { outcome: 'rejected'; entries: MealLogEntry[]; message: string };

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

/**
 * Offline write queue status for the patient tab shell (SyncStatusChip and
 * its detail sheet). Demo and unresolved accounts report `enabled: false`
 * and an empty queue — nothing renders for them.
 */
export interface PatientSyncValue {
  enabled: boolean;
  online: boolean;
  status: SyncStatus;
  /** Every queued write, oldest first (pending and failed). */
  items: readonly QueuedWrite[];
  /** Recoverable food baskets still held under their original queue/entry ids. */
  foodSubmissions: readonly RecoverableFoodSubmission[];
  pendingCount: number;
  failedCount: number;
  /**
   * True once a drain has been pending longer than the syncing grace
   * period. A normal online save acks before this flips, so the shell shows
   * "syncing" only for a save that is actually taking a while.
   */
  slowSync: boolean;
  /**
   * True briefly after the queue drains, so the shell can flash "Up to date".
   * Only set when the chip was already on screen for that drain — a fast,
   * invisible save produces no flash.
   */
  justSynced: boolean;
  /** Whether an entity has an unsent write (see pendingEntityKeys for the keys). */
  isPending: (entityKey: string) => boolean;
  retry: (id: string) => void;
  /** Re-arms only a recoverable food submission; never creates new ids. */
  retryFoodSubmission: (queueId: string) => boolean;
  retryAll: () => void;
  discard: (id: string) => Promise<void>;
}

export interface RecoverableFoodSubmission {
  queueId: string;
  entries: readonly MealLogEntry[];
  status: 'pending' | 'rejected';
  attempts: number;
  message: string | null;
  createdAt: number;
}

const DISABLED_SYNC: PatientSyncValue = {
  enabled: false,
  online: true,
  status: 'idle',
  items: [],
  foodSubmissions: [],
  pendingCount: 0,
  failedCount: 0,
  slowSync: false,
  justSynced: false,
  isPending: () => false,
  retry: () => undefined,
  retryFoodSubmission: () => false,
  retryAll: () => undefined,
  discard: async () => undefined,
};

const PatientSyncContext = createContext<PatientSyncValue>(DISABLED_SYNC);

/** How long the shell's "Up to date" confirmation stays up after a drain. */
const JUST_SYNCED_MS = 2500;

/**
 * What a real account keeps on this device between launches so the diary
 * can open — and accept writes — while the server is unreachable. Only
 * server-confirmed data lands here (hydration results plus acked queue
 * items); the read token is deliberately NOT cached.
 */
interface CachedAccountSnapshot {
  state: PersistedState;
  flags: HydratedOnboardingFlags | null;
  privacy: PrivacyState | null;
  entry: PatientEntryFacts | null;
  profile: PatientProfile | null;
}

function parseSnapshot(raw: string | null): CachedAccountSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedAccountSnapshot>;
    if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state !== 'object') {
      return null;
    }
    const stored = parsed.state as Partial<PersistedState>;
    const safeSnapshotRows = <T extends { nutritionSnapshot?: unknown }>(value: unknown): T[] => {
      if (!Array.isArray(value)) return [];
      return value.flatMap(candidate => {
        if (!candidate || typeof candidate !== 'object') return [];
        const row = candidate as T;
        if (row.nutritionSnapshot === undefined) return [row];
        const nutritionSnapshot = parseNutritionSnapshot(row.nutritionSnapshot);
        return nutritionSnapshot ? [{ ...row, nutritionSnapshot } as T] : [];
      });
    };
    return {
      state: {
        ...EMPTY_STATE,
        ...stored,
        addedEntries: safeSnapshotRows<MealLogEntry>(stored.addedEntries),
        customFoods: safeSnapshotRows<FoodItem>(stored.customFoods),
        catalogFoods: safeSnapshotRows<FoodItem>(stored.catalogFoods),
      },
      flags: parsed.flags ?? null,
      privacy: parsed.privacy ?? null,
      entry: parsed.entry ?? null,
      profile: parsed.profile ?? null,
    };
  } catch {
    return null;
  }
}

const WRITE_FAILED_MESSAGE = 'That didn’t save. Check your connection and try again.';
const HYDRATE_FAILED_MESSAGE = 'Couldn’t load your diary. Retry in a moment.';
const CACHED_DIARY_MESSAGE = 'Showing your last synced diary. Retry to refresh.';
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

  // ─── Offline write queue (real accounts) ──────────────────────────────────
  // `state` stays the single optimistic view every screen reads. Underneath
  // it, baseRef is the last server-confirmed snapshot and queueRef the
  // writes not yet acknowledged, so state === project(base, queue) (+ the
  // device-local catalog cache). Acks advance the base; discards and fresh
  // hydrations recompute state from it — which is how server truth wins.
  const queueRef = useRef<QueuedWrite[]>([]);
  const [queue, setQueue] = useState<QueuedWrite[]>([]);
  const baseRef = useRef<PersistedState>(EMPTY_STATE);
  const cachedFactsRef = useRef<Omit<CachedAccountSnapshot, 'state'>>({
    flags: null,
    privacy: null,
    entry: null,
    profile: null,
  });
  const drainingRef = useRef(false);
  const drainAgainRef = useRef(false);
  const forceAttemptRef = useRef(false);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSyncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [online, setOnline] = useState(() => isOnline());
  const onlineRef = useRef(online);
  const [justSynced, setJustSynced] = useState(false);
  const [slowSync, setSlowSync] = useState(false);
  // Whether the sync chip has been on screen at any point for the current
  // (non-empty) queue: offline with changes waiting, needs attention, or a
  // slow drain. The "Up to date" flash only follows a drain the patient saw.
  const chipShownRef = useRef(false);

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
  /**
   * True while baseRef holds the cached snapshot from an offline launch
   * rather than a live server answer. The drain must not replay on top of
   * it: a queued edit of a row deleted since the snapshot would resurrect
   * the row. refreshTruth clears it once a fresh GET lands.
   */
  const truthFromCacheRef = useRef(false);
  const refreshAttemptsRef = useRef(0);
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
  const [hydratedPrivacy, setHydratedPrivacy] = useState<PrivacyState | null>(null);
  const [entryFacts, setEntryFacts] = useState<PatientEntryFacts | null>(null);
  const [profile, setProfile] = useState<PatientProfile | null>(null);

  // Device-local calendar day, live for real accounts only. Demo (and the
  // unresolved in-between) stays pinned to the seeded anchor so every seeded
  // suite and the persona walkthrough remain byte-identical.
  const [liveDayKey, setLiveDayKey] = useState(() => localTodayKey());
  const todayKey = account.kind === 'real' ? liveDayKey : TODAY_KEY;

  // Local-midnight rollover for real accounts: recompute the device-local day
  // when the app returns to the foreground and at the next local midnight
  // (self-re-arming: the effect re-runs when liveDayKey advances). Demo stays
  // pinned to the anchor, so this never runs for seeded suites.
  useEffect(() => {
    if (account.kind !== 'real') return;
    const refresh = () => {
      const current = localTodayKey();
      setLiveDayKey(previous => (previous === current ? previous : current));
    };
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active') refresh();
    });
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 30);
    const timer = setTimeout(refresh, Math.max(1_000, nextMidnight.getTime() - Date.now()));
    // Under Node (scripted suites) a pending timer would hold the process
    // open for hours; unref where available (React Native has no unref).
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => {
      subscription.remove();
      clearTimeout(timer);
    };
  }, [account.kind, liveDayKey]);

  // When the day advances, keep the hydrated calendar facts in step so
  // program-day labels move with the date without waiting for a refetch.
  // Program day uses the server's formula (round of whole days, clamped).
  useEffect(() => {
    if (account.kind !== 'real') return;
    setEntryFacts(previous => {
      if (!previous || previous.todayKey === liveDayKey) return previous;
      const start = Date.parse(`${previous.programStartDate.slice(0, 10)}T00:00:00Z`);
      const today = Date.parse(`${liveDayKey}T00:00:00Z`);
      const programDay =
        Number.isFinite(start) && Number.isFinite(today)
          ? Math.max(1, Math.min(2000, Math.round((today - start) / 86_400_000)))
          : previous.programDay;
      return { ...previous, todayKey: liveDayKey, programDay };
    });
  }, [account.kind, liveDayKey]);

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

  // The mutation chain (declared early so the queue helpers below can use it).
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

  /** Replaces the queue for the given account generation and persists it. */
  const replaceQueue = useCallback((next: QueuedWrite[], run: MutationRun): void => {
    if (run.epoch !== epochRef.current || run.account.kind !== 'real') return;
    queueRef.current = next;
    setQueue(next);
    writePersistedRaw(queueKeyFor(run.account.patientId), serializeQueue(next)).catch(error => {
      console.error('Offline queue persist failed', error);
    });
  }, []);

  /** Persists the server-confirmed snapshot the next offline launch opens on. */
  const persistSnapshot = useCallback((run: MutationRun): void => {
    if (run.epoch !== epochRef.current || run.account.kind !== 'real') return;
    const snapshot: CachedAccountSnapshot = {
      state: baseRef.current,
      ...cachedFactsRef.current,
    };
    writePersistedRaw(snapshotKeyFor(run.account.patientId), JSON.stringify(snapshot)).catch(
      error => {
        console.error('Diary snapshot persist failed', error);
      },
    );
  }, []);

  /** state = project(base, queue). */
  const recomputeFromBase = useCallback(
    (run: MutationRun): Promise<void> =>
      commit(
        projectQueue(baseRef.current, queueRef.current),
        run,
      ),
    [commit],
  );

  const flashJustSynced = useCallback(() => {
    // A save that never showed the chip gets no confirmation either.
    if (!chipShownRef.current) return;
    if (justSyncedTimerRef.current) clearTimeout(justSyncedTimerRef.current);
    setJustSynced(true);
    const timer = setTimeout(() => {
      justSyncedTimerRef.current = null;
      setJustSynced(false);
    }, JUST_SYNCED_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    justSyncedTimerRef.current = timer;
  }, []);

  /**
   * Sends one queued write. Returns the item as acknowledged — a photo
   * upload comes back carrying its uploadedPath so the base projection
   * records the stored object, not the local bytes.
   */
  const performWrite = useCallback(
    async (item: QueuedWrite, run: MutationRun & { account: { kind: 'real' } }): Promise<QueuedWrite> => {
      const api = run.account.api;
      const options = { idempotencyKey: item.id };
      const write = item.payload;
      switch (write.kind) {
        case 'entries':
          await api.writeEntries(
            {
              ...(write.upsert && write.upsert.length > 0 ? { upsert: write.upsert } : {}),
              ...(write.deleteIds && write.deleteIds.length > 0 ? { deleteIds: write.deleteIds } : {}),
              ...(write.recents ? { recents: write.recents } : {}),
            },
            options,
          );
          return item;
        case 'water':
          await api.writeWater(write.dateKey, write.oz, options);
          return item;
        case 'targets':
          await api.writeTargets(write.partial, options);
          return item;
        case 'prefs':
          await api.writePrefs(
            {
              ...(write.favorites ? { favorites: write.favorites } : {}),
              ...(write.recents ? { recents: write.recents } : {}),
            },
            options,
          );
          return item;
        case 'library':
          await api.writeLibrary(write.input, options);
          return item;
        case 'checkIn':
          await api.writeCheckIn(write.checkIn, options);
          return item;
        case 'medication':
          await api.writeMedication(medicationInputOf(write.medication), options);
          return item;
        case 'doseLog':
          await api.writeDoseLog(write.log, options);
          return item;
        case 'flags':
          await api.writeFlags(write.flags, options);
          return item;
        case 'photos':
          await api.writeProgressPhotos(write.photos.map(photoWire), options);
          return item;
        case 'photoRemove':
          await api.removeProgressPhoto(write.photoId, options);
          return item;
        case 'photoUpload': {
          let uploadedPath = write.uploadedPath;
          if (!uploadedPath) {
            if (!write.photo.uri) {
              // Bytes lost (storage evicted them) — nothing can be uploaded.
              // Permanent, so it parks under "needs attention" for discard.
              throw new PatientDataError('This photo’s data is no longer on this device.', null, {
                kind: 'http',
                status: 410,
              });
            }
            // Pinned upload id: every attempt mints the same object path, so
            // a lost finalize response can never leave a second, invisible
            // object behind (the retry overwrites and re-finalizes it).
            const uploaded = await api.uploadProgressPhoto(write.photo.uri, {
              uploadId: write.uploadId ?? write.photo.id,
            });
            uploadedPath = uploaded.photoPath;
            // Record the finished upload BEFORE the grid write: a lost
            // response then replays the keyed grid write, never a second
            // upload of the same bytes.
            const recorded: QueuedWrite = {
              ...item,
              payload: { ...write, uploadedPath },
            };
            replaceQueue(
              queueRef.current.map(queued => (queued.id === item.id ? recorded : queued)),
              run,
            );
            item = recorded;
          }
          await api.writeProgressPhotos(
            [photoWire({ ...write.photo, objectPath: uploadedPath })],
            options,
          );
          return { ...item, payload: { ...write, uploadedPath } };
        }
      }
    },
    [replaceQueue],
  );

  const scheduleDrain = useRef<(delayMs: number) => void>(() => undefined);
  const drainRef = useRef<() => Promise<void>>(async () => undefined);

  /**
   * Quietly re-fetches server truth for an account that opened on its
   * cached snapshot, reconciles the queue against it (server-deleted rows
   * drop their queued edits), and recomputes the optimistic state — no
   * hydration flash. Returns false when the server is still unreachable.
   */
  const refreshTruth = useCallback(
    async (run: MutationRun): Promise<boolean> => {
      const acct = run.account;
      if (acct.kind !== 'real') return false;
      try {
        const [server, profile] = await Promise.all([
          acct.api.fetchState(undefined, undefined, localTodayKey()),
          typeof acct.api.fetchProfile === 'function' ? acct.api.fetchProfile() : Promise.resolve(null),
        ]);
        if (epochRef.current !== run.epoch) return false;
        const base = baseFromServer(server);
        const reconciled = reconcileQueue(queueRef.current, base);
        const flags: HydratedOnboardingFlags = {
          onboardingAnswers: server.flags.onboardingAnswers ?? null,
          notificationPrefs: server.flags.notificationPrefs ?? null,
          onboardingComplete: server.flags.onboardingComplete,
        };
        baseRef.current = base;
        cachedFactsRef.current = {
          flags,
          privacy: server.privacy ?? cachedFactsRef.current.privacy,
          entry: server.entry,
          profile,
        };
        truthFromCacheRef.current = false;
        refreshAttemptsRef.current = 0;
        replaceQueue(reconciled, run);
        persistSnapshot(run);
        await commit(
          projectQueue(base, reconciled),
          run,
        );
        if (epochRef.current !== run.epoch) return false;
        setHydratedFlags(flags);
        if (server.privacy) setHydratedPrivacy(server.privacy);
        setEntryFacts(server.entry);
        setProfile(profile);
        setSyncNotice(prev => (prev?.message === CACHED_DIARY_MESSAGE ? null : prev));
        return true;
      } catch {
        return false;
      }
    },
    [commit, persistSnapshot, replaceQueue],
  );

  /**
   * Single-flight, in-order replay. The first pending item is sent; a
   * retryable failure re-arms it with backoff and STOPS the pass (later
   * writes must not overtake it), while a permanent failure parks it as
   * failed and lets the rest proceed. Halts while the device reports
   * offline, except for a manual retry (forceAttemptRef), which always
   * tries once so a stale offline hint can never strand the queue.
   */
  const drain = useCallback(async (): Promise<void> => {
    if (drainingRef.current) {
      drainAgainRef.current = true;
      return;
    }
    drainingRef.current = true;
    const epoch = epochRef.current;
    try {
      const account = runAccountRef.current;
      if (account.kind !== 'real' || !serverTruthRef.current || !hydrationGate.current?.settled) return;
      const run = { epoch, account };
      while (epochRef.current === epoch) {
        const item = queueRef.current.find(queued => queued.status === 'pending');
        if (!item) break;
        const force = forceAttemptRef.current;
        forceAttemptRef.current = false;
        if (!onlineRef.current && !force) break;
        if (truthFromCacheRef.current) {
          // Opened on a snapshot: fetch live truth first so the replay
          // never resurrects a row the server has since deleted.
          const refreshed = await refreshTruth(run);
          if (epochRef.current !== epoch) return;
          if (!refreshed) {
            refreshAttemptsRef.current += 1;
            scheduleDrain.current(backoffDelay(refreshAttemptsRef.current));
            break;
          }
          continue; // re-read the (possibly reconciled) queue head
        }
        const wait = item.nextAttemptAt - Date.now();
        if (wait > 0 && !force) {
          scheduleDrain.current(wait);
          break;
        }
        try {
          const acked = await performWrite(item, run);
          if (epochRef.current !== epoch) return;
          baseRef.current = projectWrite(baseRef.current, acked);
          const remaining = queueRef.current.filter(queued => queued.id !== item.id);
          replaceQueue(remaining, run);
          persistSnapshot(run);
          if (acked.payload.kind === 'photoUpload') {
            // The bytes are on the media rail now: point the grid row at
            // the stored object and free the local copy.
            const { photo, uploadedPath } = acked.payload;
            const current = stateRef.current;
            await commit(
              {
                ...current,
                photos: current.photos.map(row => {
                  if (row.id !== photo.id) return row;
                  const { uri: _uri, ...rest } = row;
                  return { ...rest, objectPath: uploadedPath };
                }),
              },
              run,
            );
            removePersisted(blobKeyFor(item.id)).catch(() => undefined);
          }
          if (remaining.length === 0) flashJustSynced();
        } catch (error) {
          if (epochRef.current !== epoch) return;
          const latest = queueRef.current.find(queued => queued.id === item.id) ?? item;
          const failed = markAttemptFailed(latest, error, Date.now());
          replaceQueue(
            queueRef.current.map(queued => (queued.id === item.id ? failed : queued)),
            run,
          );
          if (failed.status === 'pending') {
            scheduleDrain.current(Math.max(0, failed.nextAttemptAt - Date.now()));
            break;
          }
          // Parked as failed: fall through to the next pending item.
        }
      }
    } finally {
      drainingRef.current = false;
      if (drainAgainRef.current) {
        drainAgainRef.current = false;
        void drainRef.current();
      }
    }
  }, [commit, flashJustSynced, performWrite, persistSnapshot, refreshTruth, replaceQueue]);
  drainRef.current = drain;

  const kickDrain = useCallback(() => {
    void drainRef.current();
  }, []);

  scheduleDrain.current = (delayMs: number) => {
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    const timer = setTimeout(() => {
      drainTimerRef.current = null;
      kickDrain();
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    drainTimerRef.current = timer;
  };

  // Replay triggers: connectivity returning and the app foregrounding.
  // Real accounts only — the demo persona has no queue to drain.
  useEffect(() => {
    if (account.kind !== 'real') return;
    const unsubscribe = subscribeConnectivity(next => {
      onlineRef.current = next;
      setOnline(next);
      if (next) kickDrain();
    });
    const subscription = AppState.addEventListener('change', status => {
      if (status !== 'active') return;
      const now = isOnline();
      onlineRef.current = now;
      setOnline(now);
      kickDrain();
    });
    return () => {
      unsubscribe();
      subscription.remove();
    };
  }, [account.kind, kickDrain]);

  /**
   * Real-account write path: commit the optimistic state, queue the server
   * write, and start the replay. The write is accepted the moment it is
   * queued — offline or not — and shows as pending until the server
   * acknowledges it. Runs inside the serialized mutation chain. Returns
   * false only when the account cannot accept writes at all (unresolved
   * lookup, or a real account with no server or cached truth yet).
   */
  const commitQueued = useCallback(
    async (
      run: MutationRun,
      next: PersistedState,
      write: { payload: QueuedWritePayload; summary: string; editIds?: string[] },
      onQueued?: (queueId: string) => void,
    ): Promise<boolean> => {
      if (run.account.kind !== 'real') {
        // Only 'unresolved' reaches here (demo branches commit locally):
        // block loudly — a local-only save would strand data somewhere no
        // future sign-in could see.
        setSyncNotice({ message: ACCOUNT_BLOCKED_MESSAGE, action: 'retry-account' });
        return false;
      }
      if (!serverTruthRef.current) {
        // Belt-and-suspenders behind requireWritableAccount: never queue a
        // write built on non-authoritative (empty) state.
        setSyncNotice({ message: DIARY_BLOCKED_MESSAGE, action: 'retry-hydration' });
        return false;
      }
      await commit(next, run);
      const now = Date.now();
      const item: QueuedWrite = {
        id: nextRealId('w'),
        payload: write.payload,
        summary: write.summary,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: now,
        status: 'pending',
        lastError: null,
        ...(write.editIds && write.editIds.length > 0 ? { editIds: write.editIds } : {}),
      };
      if (item.payload.kind === 'photoUpload' && item.payload.photo.uri) {
        try {
          await writePersistedRaw(blobKeyFor(item.id), item.payload.photo.uri);
        } catch (error) {
          // The in-memory copy still uploads this session; only a relaunch
          // before it lands would lose the bytes (and park the item).
          console.error('Offline photo persist failed', error);
        }
      }
      replaceQueue([...queueRef.current, item], run);
      onQueued?.(item.id);
      kickDrain();
      return true;
    },
    [commit, kickDrain, replaceQueue],
  );

  const isPending = useMemo(() => {
    const keys = pendingEntityKeys(queue);
    return (entityKey: string) => keys.has(entityKey);
  }, [queue]);

  // Delayed "syncing": the chip stays quiet for a normal online save and
  // only reports a drain that has been pending for the whole grace period.
  // The clock runs on the queue being continuously non-empty (offline
  // periods included), and resets the moment it empties.
  const queueNonEmpty = queue.length > 0;
  useEffect(() => {
    if (!queueNonEmpty) {
      setSlowSync(false);
      return undefined;
    }
    // A new queue cycle ends any confirmation still up from the last one:
    // otherwise a fast, invisible save started during the flash would
    // bring "Up to date" back once it drained.
    if (justSyncedTimerRef.current) {
      clearTimeout(justSyncedTimerRef.current);
      justSyncedTimerRef.current = null;
    }
    setJustSynced(false);
    const timer = setTimeout(() => setSlowSync(true), SYNC_CHIP_TUNING.syncingGraceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  }, [queueNonEmpty]);

  const anyFailed = queue.some(item => item.status === 'failed');
  useEffect(() => {
    if (!queueNonEmpty) chipShownRef.current = false;
    else if (!online || anyFailed || slowSync) chipShownRef.current = true;
  }, [queueNonEmpty, online, anyFailed, slowSync]);

  const retryQueued = useCallback((id: string) => {
    const account = runAccountRef.current;
    if (account.kind !== 'real') return;
    const run = { epoch: epochRef.current, account };
    const now = Date.now();
    replaceQueue(
      queueRef.current.map(item => (item.id === id ? markRetryRequested(item, now) : item)),
      run,
    );
    forceAttemptRef.current = true;
    kickDrain();
  }, [kickDrain, replaceQueue]);

  const retryAllQueued = useCallback(() => {
    const account = runAccountRef.current;
    if (account.kind !== 'real') return;
    const run = { epoch: epochRef.current, account };
    const now = Date.now();
    replaceQueue(
      queueRef.current.map(item => (item.status === 'failed' ? markRetryRequested(item, now) : item)),
      run,
    );
    forceAttemptRef.current = true;
    kickDrain();
  }, [kickDrain, replaceQueue]);

  /** Drops a queued write; the diary re-reads as the server (plus the rest) has it. */
  const discardQueued = useCallback(async (id: string): Promise<void> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind !== 'real') return;
      if (!queueRef.current.some(item => item.id === id)) return;
      replaceQueue(queueRef.current.filter(item => item.id !== id), run);
      removePersisted(blobKeyFor(id)).catch(() => undefined);
      await recomputeFromBase(run);
    });
  }, [beginRun, recomputeFromBase, replaceQueue, runSerialized]);

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
      // The offline queue and server snapshot belong to the previous
      // account: drop them from memory at once (their on-device copies stay
      // under that account's own keys and only its next sign-in reads them).
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      forceAttemptRef.current = false;
      queueRef.current = [];
      setQueue([]);
      baseRef.current = EMPTY_STATE;
      cachedFactsRef.current = { flags: null, privacy: null, entry: null, profile: null };
      setJustSynced(false);
      // The media read token belongs to the previous account; the new
      // account's own token arrives with its hydration (demo never has one).
      setPatientMediaToken(null);
      setHydratedFlags(null);
      setHydratedPrivacy(null);
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
      // A signup that just finished handed back this account's privacy
      // state with no consent on record. Open exactly as the server's
      // CONSENT_REQUIRED answer would (seedless, writes BLOCKED, entry guard
      // parks the account on /consent) without the round trips that would
      // only confirm it. One-shot: consent landing rehydrates from the server.
      const seeded = takeSignupSeed(acct.patientId);
      if (seeded) {
        setHydratedPrivacy(seeded.privacy);
        finish(EMPTY_STATE);
        return;
      }
      (async () => {
        const currentLocalDay = localTodayKey();
        const [serverResult, profileResult, localResult, queueResult, snapshotResult] = await Promise.allSettled([
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
          readPersistedState(queueKeyFor(acct.patientId)),
          readPersistedState(snapshotKeyFor(acct.patientId)),
        ]);
        if (epochRef.current !== epoch) return;
        // Writes queued by an earlier session of THIS account (a same-account
        // rehydrate keeps whatever is already in memory — it is newer).
        let storedQueue: QueuedWrite[] =
          queueRef.current.length > 0
            ? queueRef.current
            : parseQueue(queueResult.status === 'fulfilled' ? queueResult.value : null);
        if (queueRef.current.length === 0 && storedQueue.length > 0) {
          // Re-attach photo bytes stored out of line for uploads still pending.
          storedQueue = await Promise.all(
            storedQueue.map(async item => {
              if (item.payload.kind !== 'photoUpload' || item.payload.uploadedPath) return item;
              const bytes = await readPersistedState(blobKeyFor(item.id)).catch(() => null);
              return bytes
                ? { ...item, payload: { ...item.payload, photo: { ...item.payload.photo, uri: bytes } } }
                : item;
            }),
          );
          if (epochRef.current !== epoch) return;
        }
        const cached = parseSnapshot(snapshotResult.status === 'fulfilled' ? snapshotResult.value : null);
        const run: MutationRun = { epoch, account: acct };
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
          const base = baseFromServer(server);
          truthFromCacheRef.current = false;
          // Server truth wins: queued EDITS of rows the server no longer
          // has are dropped rather than replayed as resurrections; every
          // other queued write re-applies on top of the fresh snapshot.
          const reconciled = reconcileQueue(storedQueue, base);
          const flags: HydratedOnboardingFlags = {
            onboardingAnswers: server.flags.onboardingAnswers ?? null,
            notificationPrefs: server.flags.notificationPrefs ?? null,
            onboardingComplete: server.flags.onboardingComplete,
          };
          // Absent privacy = older test server: treat as "no consent yet"
          // with nothing pending, never as satisfied.
          const privacy: PrivacyState = server.privacy ?? {
            consent: {
              requiredVersion: 'unknown',
              recordedVersion: null,
              satisfied: false,
              photoAnalysis: null,
              recordedAt: null,
            },
            export: null,
            deletion: null,
            deletionPolicy: {
              graceDays: 7,
              retentionYears: 7,
            },
          };
          baseRef.current = base;
          cachedFactsRef.current = {
            flags,
            privacy,
            entry: server.entry,
            profile: profileResult.value,
          };
          queueRef.current = reconciled;
          setQueue(reconciled);
          writePersistedRaw(queueKeyFor(acct.patientId), serializeQueue(reconciled)).catch(error => {
            console.error('Offline queue persist failed', error);
          });
          persistSnapshot(run);
          finish(projectQueue(base, reconciled));
          // Onboarding truth for OnboardingProvider — answers and prefs
          // are its state, not the diary's.
          setHydratedFlags(flags);
          setHydratedPrivacy(privacy);
          setEntryFacts(server.entry);
          setProfile(profileResult.value);
          if (reconciled.length > 0) kickDrain();
        } else if (
          serverResult.status === 'rejected' &&
          serverResult.reason instanceof PatientDataError &&
          serverResult.reason.code === 'CONSENT_REQUIRED'
        ) {
          // The server refuses every data route until the current policy
          // version is on record — this is the gate, not an outage. Fetch
          // the (exempt) privacy state so the consent screen can act, open
          // seedless with writes still BLOCKED, and show no error notice:
          // the entry guard parks the account on /consent, which
          // rehydrates once consent lands.
          let privacy: PrivacyState | null = null;
          try {
            privacy = await acct.api.privacy.fetchPrivacy();
          } catch (privacyFailure) {
            if (epochRef.current !== epoch) return;
            setSyncNotice({
              message:
                privacyFailure instanceof Error && privacyFailure.message
                  ? privacyFailure.message
                  : HYDRATE_FAILED_MESSAGE,
              action: 'retry-hydration',
            });
            finish(local);
            return;
          }
          if (epochRef.current !== epoch) return;
          setHydratedPrivacy(privacy);
          finish(local);
        } else {
          const failure =
            serverResult.status === 'rejected'
              ? serverResult.reason
              : profileResult.status === 'rejected'
                ? profileResult.reason
                : undefined;
          if (cached) {
            // Offline (or a server hiccup) with a snapshot from an earlier
            // launch: open on the last server-confirmed diary plus this
            // account's still-queued writes, and keep accepting writes —
            // they queue behind the existing ones. The notice says what
            // the patient is looking at and offers the refresh.
            baseRef.current = cached.state;
            cachedFactsRef.current = {
              flags: cached.flags,
              privacy: cached.privacy,
              entry: cached.entry,
              profile: cached.profile,
            };
            queueRef.current = storedQueue;
            setQueue(storedQueue);
            serverTruthRef.current = true;
            // The base is a snapshot, not live truth: the drain refreshes
            // from the server before sending anything (see refreshTruth).
            truthFromCacheRef.current = true;
            if (pendingFlagsRef.current) void flushOnboardingFlags();
            setSyncNotice({ message: CACHED_DIARY_MESSAGE, action: 'retry-hydration' });
            finish(projectQueue(cached.state, storedQueue));
            setHydratedFlags(cached.flags);
            setHydratedPrivacy(cached.privacy);
            setEntryFacts(cached.entry);
            setProfile(cached.profile);
            if (storedQueue.length > 0) kickDrain();
            return;
          }
          // Explicit failure with nothing cached: open seedless with the
          // device-local slices and surface the error with a retry. Server
          // truth never arrived, so writes stay BLOCKED (serverTruthRef)
          // until a retry hydrates — otherwise a mutation computed from
          // this empty state could overwrite the account's real server data.
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

  // Anything still queued when the provider unmounts stays on disk; only
  // the timers need clearing.
  useEffect(
    () => () => {
      if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
      if (justSyncedTimerRef.current) clearTimeout(justSyncedTimerRef.current);
    },
    [],
  );

  /** Re-runs the live hydration for the current account (sync notice RETRY). */
  const rehydrate = useCallback(() => {
    startedKeyRef.current = null;
    setRehydrateTick(t => t + 1);
  }, []);

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const addEntry = useCallback(async (entry: Omit<MealLogEntry, 'id'>): Promise<void> => {
    const startEpoch = epochRef.current;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return;
      const prev = stateRef.current;
      const full: MealLogEntry = {
        ...entry,
        ...(entry.nutritionSnapshot ? scaledSnapshotMacros(entry.nutritionSnapshot) ?? {} : {}),
        id: makeId(run, 'log'),
      };
      const recents = entry.refId
        ? [entry.refId, ...prev.recents.filter(r => r !== entry.refId)].slice(0, 12)
        : prev.recents;
      const next = { ...prev, addedEntries: [...prev.addedEntries, full], recents };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitQueued(run, next, {
        payload: {
          kind: 'entries',
          upsert: [full],
          ...(recents !== prev.recents ? { recents } : {}),
        },
        summary: `Logged ${full.name}`,
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

  const submitFoodEntries = useCallback(async (
    entries: Array<Omit<MealLogEntry, 'id'>>,
  ): Promise<FoodSubmissionReceipt> => {
    if (entries.length === 0) {
      return { outcome: 'rejected', entries: [], message: 'Choose at least one food.' };
    }
    const startEpoch = epochRef.current;
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) {
        return { outcome: 'rejected', entries: [], message: ACCOUNT_BLOCKED_MESSAGE };
      }
      const prev = stateRef.current;
      const full = entries.map(entry => ({
        ...entry,
        ...(entry.nutritionSnapshot ? scaledSnapshotMacros(entry.nutritionSnapshot) ?? {} : {}),
        id: makeId(run, 'log'),
      }));
      const refIds = [...new Set(full.map(entry => entry.refId).filter((id): id is string => Boolean(id)))];
      const recents = refIds.length > 0
        ? [...refIds, ...prev.recents.filter(id => !refIds.includes(id))].slice(0, 12)
        : prev.recents;
      const next = { ...prev, addedEntries: [...prev.addedEntries, ...full], recents };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return { outcome: 'locally_saved_demo', entries: full };
      }
      let queueId = '';
      const accepted = await commitQueued(
        run,
        next,
        {
          payload: {
            kind: 'entries',
            upsert: full,
            foodSubmission: true,
            ...(recents !== prev.recents ? { recents } : {}),
          },
          summary: `Logged ${full.length} ${full.length === 1 ? 'food' : 'foods'}`,
        },
        id => { queueId = id; },
      );
      return accepted
        ? { outcome: 'queued', queueId, entries: full }
        : { outcome: 'rejected', entries: full, message: DIARY_BLOCKED_MESSAGE };
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      const saved = await commitQueued(run, next, {
        payload: { kind: 'entries', upsert: clones },
        summary: `Copied ${clones.length} ${clones.length === 1 ? 'entry' : 'entries'}`,
      });
      return saved ? clones : [];
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      const saved = await commitQueued(run, next, {
        payload: {
          kind: 'entries',
          upsert: batch,
          ...(recents !== prev.recents ? { recents } : {}),
        },
        summary: `Logged ${batch.length} ${batch.length === 1 ? 'entry' : 'entries'}`,
      });
      return saved ? batch : [];
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      const removed = prev.addedEntries.find(e => e.id === id);
      await commitQueued(run, { ...prev, ...next }, {
        payload: { kind: 'entries', deleteIds: [id] },
        summary: removed ? `Removed ${removed.name}` : 'Removed an entry',
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, { ...prev, ...next }, {
        payload: { kind: 'entries', deleteIds: removedIds },
        summary: `Removed ${removedIds.length} ${removedIds.length === 1 ? 'entry' : 'entries'}`,
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, { ...prev, ...next }, {
        payload: { kind: 'entries', upsert: restored },
        summary: restored.length === 1 ? `Restored ${restored[0].name}` : `Restored ${restored.length} entries`,
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, { ...prev, ...next }, {
        payload: { kind: 'entries', upsert: changedRows },
        summary: `Edited ${changedRows[0].name}`,
        editIds: changedRows.map(e => e.id),
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, next, {
        payload: { kind: 'water', dateKey, oz: clamped },
        summary: `Water ${clamped} oz`,
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      return await commitQueued(run, next, {
        payload: { kind: 'checkIn', checkIn: full },
        summary: 'Weekly check-in',
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

  const saveMedication = useCallback(async (
    input: Omit<MedicationInput, 'id'> & { id?: string },
  ): Promise<{ medication: MedicationRecord } | { error: string; field: string | null }> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return { error: 'Your account is not ready to save yet.', field: null };
      const prev = stateRef.current;
      const existing = input.id ? prev.medications.find(row => row.id === input.id) : undefined;
      const parsed = validateMedicationInput({ ...input, id: input.id ?? newUuid() });
      if (!parsed.ok) return { error: parsed.error, field: parsed.field };
      const medication: MedicationRecord = {
        ...parsed.value,
        source: existing?.source ?? 'patient',
        version: existing?.version ?? null,
      };
      const next = {
        ...prev,
        medications: [...prev.medications.filter(row => row.id !== medication.id), medication],
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return { medication };
      }
      const ok = await commitQueued(run, next, {
        payload: { kind: 'medication', medication },
        summary: existing ? `Updated ${medication.name}` : `Added ${medication.name}`,
      });
      return ok ? { medication } : { error: 'Couldn’t save that medication yet.', field: null };
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

  const logDose = useCallback(async (input: Omit<DoseLogWrite, 'id'>): Promise<boolean> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    return await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return false;
      const prev = stateRef.current;
      const medication = prev.medications.find(row => row.id === input.medicationId);
      if (!medication) return false;
      const loggedAt = new Date().toISOString();
      const log: DoseLogWrite = { ...input, id: newUuid() };
      const rest = prev.doseLogs.filter(
        row => !(row.medicationId === log.medicationId && row.dueDate === log.dueDate && row.dueTime === log.dueTime),
      );
      const next = {
        ...prev,
        doseLogs: log.status === null
          ? rest
          : [...rest, { id: log.id, medicationId: log.medicationId, dueDate: log.dueDate, dueTime: log.dueTime, status: log.status, source: log.source, loggedAt }],
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return true;
      }
      // The server keys decisions by occurrence, so a correction replaces
      // the earlier row there exactly as the filter above replaces it here.
      return await commitQueued(run, next, {
        payload: { kind: 'doseLog', log, loggedAt },
        summary: log.status === null
          ? `Cleared ${medication.name} dose`
          : `${log.status === 'taken' ? 'Took' : 'Skipped'} ${medication.name}`,
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      // A photo whose bytes are still local (the upload failed or never
      // ran) queues as an upload; one already on the media rail is a plain
      // grid write.
      return await commitQueued(run, next, {
        payload: !full.objectPath && full.uri
          ? { kind: 'photoUpload', photo: full }
          : { kind: 'photos', photos: [full] },
        summary: 'Progress photo',
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
        uploadId?: string;
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
        const uploadIds = new Map<string, string>();
        const full: ProgressPhoto[] = photos.map(({ uploadId, ...photo }) => {
          const row: ProgressPhoto = { id: makeId(run, 'photo'), source: 'user' as const, ...photo };
          if (uploadId) uploadIds.set(row.id, uploadId);
          return row;
        });
        const next = { ...prev, photos: [...prev.photos, ...full] };
        if (run.account.kind !== 'real') {
          await commit(next, run);
          return true;
        }
        // Uploaded shots land as one grid write; any shot still holding
        // local bytes queues its own upload behind it (in session order).
        const stored = full.filter(photo => photo.objectPath || !photo.uri);
        const local = full.filter(photo => !photo.objectPath && photo.uri);
        const writes: Array<{ payload: QueuedWritePayload; summary: string }> = [
          ...(stored.length > 0
            ? [{ payload: { kind: 'photos' as const, photos: stored }, summary: `Progress photos (${stored.length})` }]
            : []),
          ...local.map(photo => ({
            payload: {
              kind: 'photoUpload' as const,
              photo,
              ...(uploadIds.has(photo.id) ? { uploadId: uploadIds.get(photo.id) } : {}),
            },
            summary: `Progress photo (${photo.angle ?? photo.label})`,
          })),
        ];
        for (const [index, write] of writes.entries()) {
          // The first write commits the whole batch optimistically; the rest
          // only add their queue items on top of that committed state.
          const saved = await commitQueued(run, index === 0 ? next : stateRef.current, write);
          if (!saved) return false;
        }
        return true;
      });
    },
    [beginRun, commit, commitQueued, requireWritableAccount, runSerialized],
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
      await commitQueued(run, current, {
        payload: { kind: 'photoRemove', photoId: removed.photo.id },
        summary: 'Removed a progress photo',
      });
    });
  }, [beginRun, commitQueued, runSerialized]);
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
      await commitQueued(run, next, {
        payload: { kind: 'prefs', favorites },
        summary: favorites.length > prev.favorites.length ? 'Added a favorite' : 'Removed a favorite',
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

  const addCustomFood = useCallback(async (food: Omit<FoodItem, 'id' | 'category'>): Promise<FoodItem> => {
    const startEpoch = epochRef.current;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await hydrationGate.current!.promise;
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
      await commitQueued(run, next, {
        payload: { kind: 'library', input: { foodUpsert: [full] } },
        summary: `Added ${full.name} to My Foods`,
      });
      return full;
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

  const saveCatalogFood = useCallback(async (food: FoodItem): Promise<boolean> => {
    const startEpoch = epochRef.current;
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return false;
      const prev = stateRef.current;
      const snapshot: FoodItem = {
        ...food,
        ...(food.nutritionSnapshot ? scaledSnapshotMacros(food.nutritionSnapshot) ?? {} : {}),
        photoUri: undefined,
        photoPath: undefined,
        catalogShared: true,
      };
      const next = {
        ...prev,
        catalogFoods: [snapshot, ...prev.catalogFoods.filter(item => item.id !== snapshot.id)],
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return true;
      }
      return commitQueued(run, next, {
        payload: { kind: 'library', input: { foodUpsert: [snapshot] } },
        summary: `Saved ${snapshot.name} configuration`,
      });
    });
  }, [beginRun, commit, commitQueued, runSerialized]);

  const saveFoodConfiguration = useCallback(async (
    food: FoodItem,
    options: { favorite?: boolean } = {},
  ): Promise<FoodItem | null> => {
    const startEpoch = epochRef.current;
    await hydrationGate.current!.promise;
    return runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || !requireWritableAccount(run)) return null;
      const prev = stateRef.current;
      const snapshot: FoodItem = {
        ...food,
        ...(food.nutritionSnapshot ? scaledSnapshotMacros(food.nutritionSnapshot) ?? {} : {}),
        id: food.nutritionSnapshot
          ? snapshotConfigurationId(food.nutritionSnapshot)
          : food.id,
        photoUri: undefined,
        photoPath: undefined,
        catalogShared: true,
      };
      const favorites = options.favorite === undefined
        ? prev.favorites
        : options.favorite
          ? [snapshot.id, ...prev.favorites.filter(id => id !== snapshot.id)]
          : prev.favorites.filter(id => id !== snapshot.id);
      const next = {
        ...prev,
        catalogFoods: [snapshot, ...prev.catalogFoods.filter(item => item.id !== snapshot.id)],
        favorites,
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return snapshot;
      }
      const saved = await commitQueued(run, next, {
        payload: {
          kind: 'library',
          input: {
            foodUpsert: [snapshot],
            ...(favorites !== prev.favorites ? { favorites } : {}),
          },
        },
        summary: options.favorite === true
          ? `Favorited ${snapshot.name}`
          : options.favorite === false
            ? `Removed ${snapshot.name} from favorites`
            : `Saved ${snapshot.name} configuration`,
      });
      return saved ? snapshot : null;
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, next, {
        payload: { kind: 'library', input: { foodUpsert: [rebuilt] } },
        summary: `Edited ${rebuilt.name}`,
        editIds: [id],
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      const saved = await commitQueued(run, merged, {
        payload: {
          kind: 'library',
          input: {
            foodDeleteIds: [id],
            ...(merged.favorites !== prev.favorites ? { favorites: merged.favorites } : {}),
            ...(merged.recents !== prev.recents ? { recents: merged.recents } : {}),
          },
        },
        summary: removed ? `Removed ${removed.food.name} from My Foods` : 'Removed a custom food',
      });
      return saved ? removed : null;
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, merged, {
        payload: {
          kind: 'library',
          input: {
            foodUpsert: [removed.food],
            ...(merged.favorites !== prev.favorites ? { favorites: merged.favorites } : {}),
            ...(merged.recents !== prev.recents ? { recents: merged.recents } : {}),
          },
        },
        summary: `Restored ${removed.food.name}`,
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, { ...prev, savedRecipes: [...prev.savedRecipes, full] }, {
        payload: { kind: 'library', input: { recipeUpsert: [full] } },
        summary: `Saved recipe ${full.name}`,
      });
      return full;
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
      await commitQueued(run, next, {
        payload: { kind: 'library', input: { foodUpsert: [nextItem] } },
        summary: `Photo for ${nextItem.name}`,
        editIds: [id],
      });
    });
  }, [beginRun, commit, commitQueued, runSerialized]);

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
      await commitQueued(run, next, {
        payload: { kind: 'library', input: { recipeUpsert: [nextItem] } },
        summary: `Photo for ${nextItem.name}`,
        editIds: [id],
      });
    });
  }, [beginRun, commit, commitQueued, runSerialized]);

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
      await commitQueued(run, next, {
        payload: { kind: 'targets', partial: cleaned },
        summary: 'Updated daily targets',
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

  const clearLocalState = useCallback(async (): Promise<void> => {
    await hydrationGate.current!.promise;
    const startEpoch = epochRef.current;
    await runSerialized(async () => {
      const run = beginRun(startEpoch);
      if (!run || run.account.kind === 'unresolved') return;
      if (run.account.kind === 'real') {
        // Leaving this device clean for the account: nothing queued, no
        // cached diary, no photo bytes.
        const patientId = run.account.patientId;
        const blobIds = queueRef.current.map(item => item.id);
        if (drainTimerRef.current) {
          clearTimeout(drainTimerRef.current);
          drainTimerRef.current = null;
        }
        queueRef.current = [];
        setQueue([]);
        baseRef.current = EMPTY_STATE;
        await Promise.all([
          removePersisted(queueKeyFor(patientId)),
          removePersisted(snapshotKeyFor(patientId)),
          ...blobIds.map(id => removePersisted(blobKeyFor(id))),
        ]).catch(error => {
          console.error('Offline queue clear failed', error);
        });
      }
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
      await commitQueued(run, next, {
        payload: { kind: 'flags', flags: { nudgeEngaged: true } },
        summary: 'Coach check-in reply',
      });
    });
  }, [beginRun, commit, commitQueued, runSerialized]);

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
      await commitQueued(run, next, {
        payload: { kind: 'flags', flags: { nudgeOptOut: optOut } },
        summary: optOut ? 'Paused coach check-ins' : 'Resumed coach check-ins',
      });
    });
  }, [beginRun, commit, commitQueued, requireWritableAccount, runSerialized]);

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
  // assessed as of the canonical today (demo: the anchor; real: the device's
  // local day). Recomputes as the patient logs, so every surface (chat
  // seeding, check-in note) reads one decision.
  const nudgeAssessment = useMemo<NudgeAssessment>(
    () => assessNudge(classifyEntries(allEntries), weightSeries, todayKey),
    [allEntries, weightSeries, todayKey],
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
      todayKey,
    );
  }, [
    hydrated,
    nudgeAssessment,
    state.nudgeOptOut,
    state.nudgeEngaged,
    state.nudgeLastCrossingKey,
    state.nudgeLastSentKey,
    todayKey,
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
        nudgeLastSentKey: todayKey,
        nudgeLastCrossingKey: crossing,
        // A fresh episode starts unengaged even if an older one was answered.
        nudgeEngaged: false,
      };
      if (run.account.kind !== 'real') {
        await commit(next, run);
        return;
      }
      await commitQueued(run, next, {
        payload: {
          kind: 'flags',
          flags: {
            nudgeLastSentKey: todayKey,
            nudgeLastCrossingKey: crossing,
            nudgeEngaged: false,
          },
        },
        summary: 'Coach check-in',
      });
    });
  }, [beginRun, commit, commitQueued, runSerialized, nudgeAssessment, todayKey]);

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
    () => [...state.customFoods, ...state.catalogFoods, ...FOOD_DB],
    [state.customFoods, state.catalogFoods],
  );

  const value = useMemo<PatientContextValue>(
    () => ({
      hydrated,
      targets,
      favorites: state.favorites,
      customFoods: state.customFoods,
      catalogFoods: state.catalogFoods,
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
      submitFoodEntries,
      copyEntries,
      copyEntriesWithExtras,
      removeEntry,
      removeEntries,
      restoreEntry,
      restoreEntries,
      updateEntry,
      setWater,
      addCheckIn,
      medications: state.medications,
      doseLogs: state.doseLogs,
      saveMedication,
      logDose,
      addPhoto,
      addPhotos,
      removePhoto,
      restorePhoto,
      commitPhotoRemoval,
      toggleFavorite,
      addCustomFood,
      saveCatalogFood,
      saveFoodConfiguration,
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
      hydratedPrivacy,
      applyPrivacy: setHydratedPrivacy,
      rehydrate,
      todayKey,
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
      state.catalogFoods,
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
      submitFoodEntries,
      copyEntries,
      copyEntriesWithExtras,
      removeEntry,
      removeEntries,
      restoreEntry,
      restoreEntries,
      updateEntry,
      setWater,
      addCheckIn,
      state.medications,
      state.doseLogs,
      saveMedication,
      logDose,
      addPhoto,
      addPhotos,
      removePhoto,
      restorePhoto,
      commitPhotoRemoval,
      toggleFavorite,
      addCustomFood,
      saveCatalogFood,
      saveFoodConfiguration,
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
      hydratedPrivacy,
      rehydrate,
      todayKey,
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

  const syncValue = useMemo<PatientSyncValue>(() => {
    if (account.kind !== 'real') return DISABLED_SYNC;
    const foodSubmissions: RecoverableFoodSubmission[] = queue.flatMap(item => {
      if (
        item.payload.kind !== 'entries' ||
        item.payload.foodSubmission !== true ||
        !item.payload.upsert ||
        item.payload.upsert.length === 0
      ) {
        return [];
      }
      return [{
        queueId: item.id,
        entries: item.payload.upsert,
        status: item.status === 'failed' ? 'rejected' : 'pending',
        attempts: item.attempts,
        message: item.lastError,
        createdAt: item.createdAt,
      }];
    });
    return {
      enabled: true,
      online,
      status: deriveSyncStatus(queue, online),
      items: queue,
      foodSubmissions,
      pendingCount: queue.filter(item => item.status === 'pending').length,
      failedCount: queue.filter(item => item.status === 'failed').length,
      slowSync,
      justSynced,
      isPending,
      retry: retryQueued,
      retryFoodSubmission: queueId => {
        const item = queue.find(candidate =>
          candidate.id === queueId &&
          candidate.payload.kind === 'entries' &&
          candidate.payload.foodSubmission === true
        );
        if (!item) return false;
        retryQueued(queueId);
        return true;
      },
      retryAll: retryAllQueued,
      discard: discardQueued,
    };
  }, [account.kind, discardQueued, isPending, justSynced, online, queue, retryAllQueued, retryQueued, slowSync]);

  return (
    <PatientContext.Provider value={value}>
      <PatientSyncNoticeContext.Provider value={noticeValue}>
        <PatientSyncContext.Provider value={syncValue}>
          {children}
        </PatientSyncContext.Provider>
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

/** Offline write-queue status; disabled (empty) outside a real account. */
export function usePatientSync(): PatientSyncValue {
  return useContext(PatientSyncContext);
}
