import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ClaimTestScenario =
  | 'claim_phone'
  | 'recover_phone'
  | 'claim_email'
  | 'recover_email';

export interface ClaimTestHandoff {
  scenario: ClaimTestScenario;
  identifier: string;
  mode: 'create' | 'reset';
  /** Device cleanup failed after the server committed the prepared test state. */
  cleanupWarning?: boolean;
}

const STORAGE_KEY = 'thinnr_claim_test_handoff_v1';
let memoryHandoff: ClaimTestHandoff | null = null;

async function read(): Promise<string | null> {
  return Platform.OS === 'web'
    ? globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
    : AsyncStorage.getItem(STORAGE_KEY);
}

export async function saveClaimTestHandoff(value: ClaimTestHandoff): Promise<boolean> {
  // The destination screen is in the same JS runtime. Put the handoff here
  // first so a full disk/quota error cannot strand a server-committed reset.
  memoryHandoff = value;
  const serialized = JSON.stringify(value);
  try {
    if (Platform.OS === 'web') {
      const storage = globalThis.localStorage;
      if (!storage) return false;
      storage.setItem(STORAGE_KEY, serialized);
      return true;
    }
    await AsyncStorage.setItem(STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export async function getClaimTestHandoff(): Promise<ClaimTestHandoff | null> {
  if (memoryHandoff) return memoryHandoff;
  let raw: string | null;
  try {
    raw = await read();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ClaimTestHandoff>;
    const validScenario =
      value.scenario === 'claim_phone' ||
      value.scenario === 'recover_phone' ||
      value.scenario === 'claim_email' ||
      value.scenario === 'recover_email';
    const validMode = value.mode === 'create' || value.mode === 'reset';
    if (!validScenario || !validMode || typeof value.identifier !== 'string') return null;
    memoryHandoff = value as ClaimTestHandoff;
    return memoryHandoff;
  } catch {
    return null;
  }
}

export async function clearClaimTestHandoff(): Promise<boolean> {
  memoryHandoff = null;
  try {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      return true;
    }
    await AsyncStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}