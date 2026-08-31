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
import type { DailyTargets, MealLogEntry } from '@/data/patient-data';

/** The server-backed slice of a real patient's diary, as hydrated. */
export interface PatientServerState {
  entries: MealLogEntry[];
  water: Record<string, number>;
  targets: Partial<DailyTargets>;
  favorites: string[];
  recents: string[];
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
