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
  MOCK_PATIENTS,
  MOCK_SUBSCRIPTIONS,
  type Patient,
  type Subscription,
} from '@/data/mock-data';
import { sortVisitsNewestFirst, type MeasurementVisit } from '@/data/body-measurements';

const STORAGE_KEY = 'thinnr_ops_state_v1';

type WeightPoint = { date: string; weight: number };

function mergeWeightHistory(entries: WeightPoint[]): WeightPoint[] {
  return [...entries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

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

export interface ContactOverride {
  patientId: string;
  email: string;
  phone: string;
}

export interface WeightEntry {
  patientId: string;
  date: string;
  weight: number;
}

export interface NoteEntry {
  patientId: string;
  id: string;
  date: string;
  text: string;
  user: string;
}

export interface SubStatusOverride {
  patientId: string;
  status: 'active' | 'paused' | 'overdue' | 'cancelled';
}

/** A staff-logged measurement visit, persisted alongside weigh-ins and notes. */
export interface BodyMeasurementEntry extends MeasurementVisit {
  patientId: string;
}

interface PersistedState {
  contactOverrides: ContactOverride[];
  weightEntries: WeightEntry[];
  notes: NoteEntry[];
  subStatusOverrides: SubStatusOverride[];
  bodyMeasurementVisits: BodyMeasurementEntry[];
  /** Seeded or logged visit ids staff removed; hidden from every projection. */
  removedVisitIds: string[];
}

const EMPTY_STATE: PersistedState = {
  contactOverrides: [],
  weightEntries: [],
  notes: [],
  subStatusOverrides: [],
  bodyMeasurementVisits: [],
  removedVisitIds: [],
};

/** Older persisted payloads predate the measurement fields; default them so reads never crash. */
function normalizePersistedState(parsed: Partial<PersistedState>): PersistedState {
  return {
    ...EMPTY_STATE,
    ...parsed,
    bodyMeasurementVisits: Array.isArray(parsed.bodyMeasurementVisits) ? parsed.bodyMeasurementVisits : [],
    removedVisitIds: Array.isArray(parsed.removedVisitIds) ? parsed.removedVisitIds : [],
  };
}

/** Seeded visits with logged ones layered on and removed ones dropped, newest first. */
function projectBodyMeasurements(state: PersistedState, patientId: string, seeded: MeasurementVisit[]): MeasurementVisit[] {
  const removed = new Set(state.removedVisitIds);
  const logged = state.bodyMeasurementVisits
    .filter(v => v.patientId === patientId)
    .map(({ patientId: _patientId, ...visit }) => visit);
  return sortVisitsNewestFirst([...seeded, ...logged].filter(v => !removed.has(v.id)));
}

interface OperationsContextValue {
  hydrated: boolean;
  // Raw persisted arrays (for reading overrides directly)
  contactOverrides: ContactOverride[];
  weightEntries: WeightEntry[];
  notes: NoteEntry[];
  subStatusOverrides: SubStatusOverride[];
  bodyMeasurementVisits: BodyMeasurementEntry[];
  removedVisitIds: string[];
  // Merged projections — always up-to-date, reload-safe
  mergedPatients: Patient[];
  mergedSubscriptions: Subscription[];
  // Mutations
  saveContactOverride: (override: ContactOverride) => Promise<void>;
  appendWeightEntry: (entry: WeightEntry) => Promise<void>;
  appendNote: (note: NoteEntry) => Promise<void>;
  saveSubStatusOverride: (override: SubStatusOverride) => Promise<void>;
  appendBodyMeasurementVisit: (visit: BodyMeasurementEntry) => Promise<void>;
  removeBodyMeasurementVisit: (visitId: string) => Promise<void>;
  // Per-patient helpers
  getPatientContact: (patientId: string, defaultEmail: string, defaultPhone: string) => { email: string; phone: string };
  getPatientWeights: (patientId: string, baseHistory: { date: string; weight: number }[]) => { date: string; weight: number }[];
  getPatientNotes: (patientId: string) => NoteEntry[];
  getSubStatus: (patientId: string, defaultStatus: 'active' | 'paused' | 'overdue' | 'cancelled') => 'active' | 'paused' | 'overdue' | 'cancelled';
  /** Seeded visits merged with this device's logged visits (removed ones hidden), newest first. */
  getPatientBodyMeasurements: (patientId: string, seeded: MeasurementVisit[]) => MeasurementVisit[];
}

const OperationsContext = createContext<OperationsContextValue | null>(null);

/** Build merged patient list from raw state */
function buildMergedPatients(state: PersistedState): Patient[] {
  return MOCK_PATIENTS.map(p => {
    const contactOverride = state.contactOverrides.find(c => c.patientId === p.id);
    const appendedWeights = state.weightEntries
      .filter(e => e.patientId === p.id)
      .map(e => ({ date: e.date, weight: e.weight }));
    const fullHistory = mergeWeightHistory([...p.progressHistory, ...appendedWeights]);
    const latestWeight = fullHistory.at(-1)?.weight ?? p.currentWeight;
    return {
      ...p,
      email: contactOverride?.email ?? p.email,
      phone: contactOverride?.phone ?? p.phone,
      currentWeight: latestWeight,
      progressHistory: fullHistory,
      bodyMeasurements: projectBodyMeasurements(state, p.id, p.bodyMeasurements),
    };
  });
}

/** Build merged subscription list from raw state */
function buildMergedSubscriptions(state: PersistedState): Subscription[] {
  return MOCK_SUBSCRIPTIONS.map(s => {
    const override = state.subStatusOverrides.find(o => o.patientId === s.patientId);
    return override ? { ...s, status: override.status } : s;
  });
}

export function OperationsProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<PersistedState>(EMPTY_STATE);

  // Ref always holds the latest state so mutations can read it synchronously
  // without closing over a stale value.
  const stateRef = useRef<PersistedState>(EMPTY_STATE);

  // Single commit helper: update ref + React state + await storage in one shot.
  const commit = useCallback(async (next: PersistedState): Promise<void> => {
    stateRef.current = next;
    setState(next);
    await writePersistedState(next);
  }, []);

  // Hydrate from storage on mount
  useEffect(() => {
    readPersistedState()
      .then(raw => {
        if (raw) {
          try {
            const parsed = normalizePersistedState(JSON.parse(raw) as Partial<PersistedState>);
            stateRef.current = parsed;
            setState(parsed);
          } catch {
            // ignore corrupt data
          }
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  // ─── Mutations ─────────────────────────────────────────────────────────────
  // Each mutation reads from stateRef (always current), computes next state,
  // then awaits commit so the Promise only resolves after storage is written.

  const saveContactOverride = useCallback(async (override: ContactOverride): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const prev = stateRef.current;
    const next: PersistedState = {
      ...prev,
      contactOverrides: [
        ...prev.contactOverrides.filter(c => c.patientId !== override.patientId),
        override,
      ],
    };
    await commit(next);
  }, [commit]);

  const appendWeightEntry = useCallback(async (entry: WeightEntry): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const prev = stateRef.current;
    const next: PersistedState = {
      ...prev,
      weightEntries: [...prev.weightEntries, entry],
    };
    await commit(next);
  }, [commit]);

  const appendNote = useCallback(async (note: NoteEntry): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const prev = stateRef.current;
    const next: PersistedState = {
      ...prev,
      notes: [note, ...prev.notes],
    };
    await commit(next);
  }, [commit]);

  const saveSubStatusOverride = useCallback(async (override: SubStatusOverride): Promise<void> => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const prev = stateRef.current;
    const next: PersistedState = {
      ...prev,
      subStatusOverrides: [
        ...prev.subStatusOverrides.filter(s => s.patientId !== override.patientId),
        override,
      ],
    };
    await commit(next);
  }, [commit]);

  const appendBodyMeasurementVisit = useCallback(async (visit: BodyMeasurementEntry): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const prev = stateRef.current;
    const next: PersistedState = {
      ...prev,
      bodyMeasurementVisits: [...prev.bodyMeasurementVisits, visit],
    };
    await commit(next);
  }, [commit]);

  const removeBodyMeasurementVisit = useCallback(async (visitId: string): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const prev = stateRef.current;
    const next: PersistedState = {
      ...prev,
      bodyMeasurementVisits: prev.bodyMeasurementVisits.filter(v => v.id !== visitId),
      removedVisitIds: prev.removedVisitIds.includes(visitId) ? prev.removedVisitIds : [...prev.removedVisitIds, visitId],
    };
    await commit(next);
  }, [commit]);

  // ─── Per-patient helpers (read from reactive state) ────────────────────────

  const getPatientContact = useCallback(
    (patientId: string, defaultEmail: string, defaultPhone: string) => {
      const override = state.contactOverrides.find(c => c.patientId === patientId);
      return { email: override?.email ?? defaultEmail, phone: override?.phone ?? defaultPhone };
    },
    [state.contactOverrides],
  );

  const getPatientWeights = useCallback(
    (patientId: string, baseHistory: { date: string; weight: number }[]) => {
      const appended = state.weightEntries
        .filter(e => e.patientId === patientId)
        .map(e => ({ date: e.date, weight: e.weight }));
      return mergeWeightHistory([...baseHistory, ...appended]);
    },
    [state.weightEntries],
  );

  const getPatientNotes = useCallback(
    (patientId: string) => state.notes.filter(n => n.patientId === patientId),
    [state.notes],
  );

  const getSubStatus = useCallback(
    (patientId: string, defaultStatus: 'active' | 'paused' | 'overdue' | 'cancelled') => {
      const override = state.subStatusOverrides.find(s => s.patientId === patientId);
      return override?.status ?? defaultStatus;
    },
    [state.subStatusOverrides],
  );

  const getPatientBodyMeasurements = useCallback(
    (patientId: string, seeded: MeasurementVisit[]) => projectBodyMeasurements(state, patientId, seeded),
    [state],
  );

  // ─── Merged projections ────────────────────────────────────────────────────

  const mergedPatients = useMemo(() => buildMergedPatients(state), [state]);
  const mergedSubscriptions = useMemo(() => buildMergedSubscriptions(state), [state]);

  // ─── Context value ─────────────────────────────────────────────────────────

  const value = useMemo<OperationsContextValue>(
    () => ({
      hydrated,
      contactOverrides: state.contactOverrides,
      weightEntries: state.weightEntries,
      notes: state.notes,
      subStatusOverrides: state.subStatusOverrides,
      bodyMeasurementVisits: state.bodyMeasurementVisits,
      removedVisitIds: state.removedVisitIds,
      mergedPatients,
      mergedSubscriptions,
      saveContactOverride,
      appendWeightEntry,
      appendNote,
      saveSubStatusOverride,
      appendBodyMeasurementVisit,
      removeBodyMeasurementVisit,
      getPatientContact,
      getPatientWeights,
      getPatientNotes,
      getSubStatus,
      getPatientBodyMeasurements,
    }),
    [
      hydrated,
      state,
      mergedPatients,
      mergedSubscriptions,
      saveContactOverride,
      appendWeightEntry,
      appendNote,
      saveSubStatusOverride,
      appendBodyMeasurementVisit,
      removeBodyMeasurementVisit,
      getPatientContact,
      getPatientWeights,
      getPatientNotes,
      getSubStatus,
      getPatientBodyMeasurements,
    ],
  );

  return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}

export function useOperations() {
  const ctx = useContext(OperationsContext);
  if (!ctx) throw new Error('useOperations must be used within OperationsProvider');
  return ctx;
}
