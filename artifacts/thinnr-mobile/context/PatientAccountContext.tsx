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
  DailyTargets,
  FoodItem,
  MealLogEntry,
  MealSlot,
  SavedRecipe,
} from '@/data/patient-data';

/** The server-backed slice of a real patient's diary, as hydrated. */
export interface PatientServerState {
  entries: MealLogEntry[];
  water: Record<string, number>;
  targets: Partial<DailyTargets>;
  favorites: string[];
  recents: string[];
  customFoods: FoodItem[];
  savedRecipes: SavedRecipe[];
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
  fetchState(fromKey: string, toKey: string): Promise<PatientServerState>;
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
