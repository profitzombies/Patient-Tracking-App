/**
 * Last-known account resolution, per signed-in user.
 *
 * The patient shell decides the account kind from /api/claim/whoami. On an
 * offline cold start that lookup cannot run, and without a memory the app
 * would fall into the write-blocked "couldn't load your account" state,
 * stranding the offline queue and the cached diary the patient came back
 * for. So every successful resolution is remembered per user id, and a
 * FAILED lookup for the same user reuses it.
 *
 * Only a lookup failure consults the cache (never a fresh answer, which
 * always overwrites it), and the entry is keyed by the auth user id, so the
 * choice still flows from auth state rather than from missing data. The
 * server continues to gate every request by the bearer token regardless.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type { AccountRole } from './patient-data-api';

const STORAGE_KEY = 'thinnr_account_role_v1';

interface CachedRole {
  userId: string;
  role: AccountRole;
}

async function readRaw(): Promise<string | null> {
  try {
    return Platform.OS === 'web'
      ? globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
      : await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

async function writeRaw(serialized: string | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      const storage = globalThis.localStorage;
      if (!storage) return;
      if (serialized === null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, serialized);
      return;
    }
    if (serialized === null) await AsyncStorage.removeItem(STORAGE_KEY);
    else await AsyncStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Best effort: a full disk only costs the next offline cold start.
  }
}

function parse(raw: string | null): CachedRole | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedRole> | null;
    if (!parsed || typeof parsed.userId !== 'string' || !parsed.role) return null;
    const role = parsed.role as Partial<AccountRole>;
    if (role.kind === 'patient') {
      return typeof role.patientId === 'string' && role.patientId.length > 0
        ? { userId: parsed.userId, role: { kind: 'patient', patientId: role.patientId } }
        : null;
    }
    if (role.kind === 'other') return { userId: parsed.userId, role: { kind: 'other' } };
    return null;
  } catch {
    return null;
  }
}

/** The remembered role for this user, or null when none (or another user's). */
export async function readCachedAccountRole(userId: string): Promise<AccountRole | null> {
  const cached = parse(await readRaw());
  return cached && cached.userId === userId ? cached.role : null;
}

export async function writeCachedAccountRole(userId: string, role: AccountRole): Promise<void> {
  await writeRaw(JSON.stringify({ userId, role } satisfies CachedRole));
}

/** Sign-out: forget the role so the next user starts from a real lookup. */
export async function clearCachedAccountRole(): Promise<void> {
  await writeRaw(null);
}
