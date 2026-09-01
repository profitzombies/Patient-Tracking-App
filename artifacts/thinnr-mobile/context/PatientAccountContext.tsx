/**
 * Which patient the diary belongs to — the seam between the demo persona and
 * a real signed-in patient account.
 *
 * The DEFAULT context value is the ready demo account, so every tree that
 * renders PatientProvider without mounting the resolver (all the existing
 * Node test suites, and any screen preview) behaves exactly as before this
 * seam existed: seeded demo data, one local storage key, no network. The
 * app's root layout mounts PatientAccountProvider (see
 * ./PatientAccountProvider.tsx) above PatientProvider to swap in the
 * resolved account when a live session exists.
 *
 * This file must stay dependency-light — react plus erased type imports
 * only. PatientContext imports it, and PatientContext is rendered by many
 * Node suites whose module stub maps know nothing about supabase or fetch.
 */
import { createContext, useContext } from 'react';
import type {
  CheckIn,
  DailyTargets,
  FoodItem,
  MealLogEntry,
  MealSlot,
  SavedRecipe,
} from '@/data/patient-data';
import type { HealthMeasurement } from '@/lib/device-feature-core';

/**
 * One progress-photo grid row as it rides the wire: always a stored object
 * path on the account's media rail — the client stamps `source: 'user'` and
 * derives the display URL at render time.
 */
export interface ProgressPhotoWire {
  id: string;
  dateKey: string;
  label: string;
  angle?: 'front' | 'side' | 'back';
  objectPath: string;
}

/**
 * Account flags as hydrated: the stall-nudge outreach state, onboarding
 * completion/answers, and notification preferences.
 */
export interface PatientFlags {
  nudgeOptOut: boolean;
  nudgeEngaged: boolean;
  nudgeLastSentKey: string | null;
  nudgeLastCrossingKey: string | null;
  onboardingComplete: boolean;
  onboardingAnswers?: Record<string, unknown>;
  notificationPrefs?: Record<string, unknown>;
}

/** Partial flag write — only the provided fields merge into the row. */
export interface PatientFlagsWrite {
  nudgeOptOut: boolean;
  nudgeEngaged: boolean;
  nudgeLastSentKey: string | null;
  nudgeLastCrossingKey: string | null;
  onboardingComplete: boolean;
  onboardingAnswers: object;
  notificationPrefs: object;
}

/** Server-authoritative facts that define a real patient's app entry. */
export interface PatientEntryFacts {
  firstName: string;
  programStartDate: string;
  todayKey: string;
  programDay: number;
}

/** Canonical, server-owned patient identity and care-plan profile. */
export interface PatientProfile {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  heightInches: number | null;
  startingWeight: number | null;
  currentWeight: number | null;
  goalWeight: number | null;
  timezone: string | null;
  programId: string | null;
  programStartDate: string | null;
  setupComplete: boolean;
}

export type PatientProfileWrite = Partial<
  Pick<
    PatientProfile,
    | 'firstName'
    | 'lastName'
    | 'dateOfBirth'
    | 'heightInches'
    | 'startingWeight'
    | 'currentWeight'
    | 'goalWeight'
    | 'timezone'
    | 'programId'
    | 'programStartDate'
  >
>;

export interface PatientSetupWrite {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  heightInches: number;
  startingWeight: number;
  currentWeight: number;
  goalWeight: number;
  timezone: string;
  programId: string;
  programStartDate?: string;
}

/** The server-backed slice of a real patient's diary, as hydrated. */
export interface PatientServerState {
  entries: MealLogEntry[];
  water: Record<string, number>;
  targets: Partial<DailyTargets>;
  favorites: string[];
  recents: string[];
  customFoods: FoodItem[];
  savedRecipes: SavedRecipe[];
  photos: ProgressPhotoWire[];
  checkIns: CheckIn[];
  flags: PatientFlags;
  entry: PatientEntryFacts;
  /** Optional only for compatibility with older test servers during rollout. */
  profile?: PatientProfile;
}

/**
 * One compound library mutation — the server applies every part atomically,
 * so a delete and the favorites/recents it strips land (or fail) together.
 */
export interface LibraryWrite {
  foodUpsert?: FoodItem[];
  recipeUpsert?: SavedRecipe[];
  foodDeleteIds?: string[];
  recipeDeleteIds?: string[];
  favorites?: string[];
  recents?: string[];
}

/** Which durable chat surface a stored transcript belongs to. */
export type ChatThread = 'coach' | 'support';

/** Stored reference to a chat photo on the account's media rail. */
export interface ChatWirePhoto {
  path: string;
  width: number;
  height: number;
  kind?: 'menu' | 'meal' | 'label';
  mealSlot?: MealSlot;
  reused?: boolean;
  /**
   * Display URL for the stored copy, derived client-side when a transcript
   * loads (never sent to the server — outbound wires carry only the path).
   * The chat rebuilds its photo bubbles from this.
   */
  uri?: string;
}

/**
 * One finalized on-screen chat message as it rides the persistence wire —
 * exactly the client's display shape (revealed text, card, chip labels,
 * reply linkage), never the model wire shape.
 */
export interface ChatWireMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  stopped?: boolean;
  hidden?: boolean;
  card?: { kind: string; payload: unknown };
  quickReplies?: string[];
  replyToId?: string;
  photo?: ChatWirePhoto;
}

/** A stored transcript plus the greeting facts for brand-new threads. */
export interface ChatThreadSnapshot {
  messages: ChatWireMessage[];
  patient: { firstName: string; programDay: number };
}

/** The live diary rail (implemented by lib/patient-data-api.ts). */
export interface PatientDataApi {
  fetchState(fromKey?: string, toKey?: string, todayKey?: string): Promise<PatientServerState>;
  fetchProfile(): Promise<PatientProfile>;
  writeProfile(input: PatientProfileWrite): Promise<{ profile: PatientProfile }>;
  saveSetup(input: {
    profile: PatientProfileWrite;
    onboardingAnswers: object;
  }): Promise<{ profile: PatientProfile }>;
  writeEntries(input: {
    upsert?: MealLogEntry[];
    deleteIds?: string[];
    recents?: string[];
  }): Promise<void>;
  writeWater(dateKey: string, oz: number): Promise<void>;
  writeTargets(partial: Partial<DailyTargets>): Promise<void>;
  writePrefs(prefs: { favorites?: string[]; recents?: string[] }): Promise<void>;
  writeLibrary(input: LibraryWrite): Promise<void>;
  /**
   * Moves a library photo (data URI) onto the account's media rail. Returns
   * the stored object path plus the display URL that serves it.
   */
  uploadLibraryPhoto(
    kind: 'food' | 'recipe',
    dataUri: string,
  ): Promise<{ photoPath: string; photoUri: string }>;
  /** Loads the stored transcript for one chat surface (oldest first). */
  fetchChatThread(thread: ChatThread, todayKey: string): Promise<ChatThreadSnapshot>;
  /** Upserts a batch of finalized messages by client id (idempotent). */
  appendChatMessages(thread: ChatThread, messages: ChatWireMessage[]): Promise<void>;
  /** Stores a chat photo (data URI) on the account's media rail. */
  uploadChatPhoto(dataUri: string): Promise<{ photoPath: string; photoUri: string }>;
  /** Stores a progress photo (data URI) on the account's media rail. */
  uploadProgressPhoto(dataUri: string): Promise<{ photoPath: string; photoUri: string }>;
  /** Records uploaded progress photos on the account's grid. */
  writeProgressPhotos(photos: ProgressPhotoWire[]): Promise<void>;
  /**
   * Deletes a photo's grid row, media-ledger row, AND stored bytes. The app
   * only calls this after its local undo window has closed.
   */
  removeProgressPhoto(photoId: string): Promise<void>;
  /**
   * Discards uploaded progress objects that never became grid rows (a
   * failed grid write the patient walked away from). The server deletes
   * only the caller's own unreferenced progress-kind uploads.
   */
  cleanupProgressUploads(paths: string[]): Promise<void>;
  /** Records one check-in (one row per day — a same-day re-submit replaces). */
  writeCheckIn(checkIn: CheckIn): Promise<void>;
  /** Idempotently imports only the approved device-health measurement kinds. */
  importHealthMeasurements(measurements: HealthMeasurement[], accessToken?: string): Promise<{ imported: number }>;
  /** Merges the provided account flags (stall-nudge / onboarding / prefs). */
  writeFlags(flags: Partial<PatientFlagsWrite>): Promise<void>;
  /** Safely commits a resumable onboarding checkpoint. */
  /** Atomically validates and commits every required canonical setup field. */
  completeSetup(input: {
    profile: PatientSetupWrite;
    onboardingAnswers: object;
    notificationPrefs: object;
  }): Promise<{ profile: PatientProfile }>;
  /** Sends a one-time code before changing a canonical contact field. */
  requestProfileVerification(input: {
    kind: 'email' | 'phone';
    value: string;
  }): Promise<{ requestId: string; message: string; devCode?: string }>;
  /** Confirms a contact code and returns the updated canonical profile. */
  verifyProfileContact(input: {
    requestId: string;
    code: string;
  }): Promise<{ profile: PatientProfile }>;
}

export type PatientAccount =
  /** The guided demo persona: seeded history plus this device's local layer. */
  | { kind: 'demo' }
  /**
   * A live session exists but the account lookup failed (server unreachable).
   * The diary stays seedless and blocks writes behind a retry — never demo
   * data (which would read as the patient's own history) and never a silent
   * local-only save a future sign-in could not see.
   */
  | { kind: 'unresolved' }
  /** A signed-in patient: hydrate from and write through the API server. */
  | { kind: 'real'; patientId: string; api: PatientDataApi };

export interface PatientAccountState {
  /** True while a live session exists whose account is still being resolved. */
  resolving: boolean;
  account: PatientAccount;
  /** Plain-words notice when account.kind === 'unresolved'. */
  accountNotice: string | null;
  /** Re-runs the account lookup after an 'unresolved' failure. */
  retryResolve: () => void;
  /**
   * Bearer token supplier for streaming calls that authenticate per turn
   * (coach chat). Present only when a live session exists — the demo
   * default omits it, so demo requests stay tokenless and byte-identical.
   */
  getAccessToken?: () => Promise<string | null>;
}

export const DEMO_ACCOUNT_STATE: PatientAccountState = {
  resolving: false,
  account: { kind: 'demo' },
  accountNotice: null,
  retryResolve: () => {},
};

export const PatientAccountContext = createContext<PatientAccountState>(DEMO_ACCOUNT_STATE);

export function usePatientAccount(): PatientAccountState {
  return useContext(PatientAccountContext);
}
