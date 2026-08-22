/**
 * App mode: which persona is using the device — staff (care team) or patient.
 * Persisted so the app reopens in the same mode. `null` means not chosen yet,
 * which routes to the persona picker.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'thinnr_app_mode_v1';

export type AppMode = 'staff' | 'patient';

async function readPersistedMode(): Promise<AppMode | null> {
  const raw = Platform.OS === 'web'
    ? globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
    : await AsyncStorage.getItem(STORAGE_KEY);
  return raw === 'staff' || raw === 'patient' ? raw : null;
}

async function writePersistedMode(mode: AppMode): Promise<void> {
  if (Platform.OS === 'web') {
    const storage = globalThis.localStorage;
    if (!storage) {
      throw new Error('Browser local storage is unavailable.');
    }
    storage.setItem(STORAGE_KEY, mode);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, mode);
}

interface AppModeContextValue {
  hydrated: boolean;
  mode: AppMode | null;
  setMode: (mode: AppMode) => Promise<void>;
}

const AppModeContext = createContext<AppModeContextValue | null>(null);

export function AppModeProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [mode, setModeState] = useState<AppMode | null>(null);

  useEffect(() => {
    readPersistedMode()
      .then(stored => {
        if (stored) setModeState(stored);
      })
      .finally(() => setHydrated(true));
  }, []);

  const setMode = useCallback(async (next: AppMode): Promise<void> => {
    setModeState(next);
    await writePersistedMode(next);
  }, []);

  const value = useMemo<AppModeContextValue>(
    () => ({ hydrated, mode, setMode }),
    [hydrated, mode, setMode],
  );

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}

export function useAppMode() {
  const ctx = useContext(AppModeContext);
  if (!ctx) throw new Error('useAppMode must be used within AppModeProvider');
  return ctx;
}
