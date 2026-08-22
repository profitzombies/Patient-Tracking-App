import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Patient, WeightEntry } from "@/data/mock-data";

interface PatientSessionValue {
  getProgressHistory: (patient: Patient) => WeightEntry[];
  getCurrentWeight: (patient: Patient) => number;
  addWeightEntry: (patient: Patient, entry: WeightEntry) => void;
}

const PatientSessionContext = createContext<PatientSessionValue | null>(null);

export function PatientSessionProvider({ children }: { children: ReactNode }) {
  const [weightOverrides, setWeightOverrides] = useState<Record<string, WeightEntry[]>>({});

  const getProgressHistory = useCallback(
    (patient: Patient) => weightOverrides[patient.id] ?? patient.progressHistory,
    [weightOverrides],
  );

  const getCurrentWeight = useCallback(
    (patient: Patient) => getProgressHistory(patient).at(-1)?.weight ?? patient.currentWeight,
    [getProgressHistory],
  );

  const addWeightEntry = useCallback((patient: Patient, entry: WeightEntry) => {
    setWeightOverrides((current) => ({
      ...current,
      [patient.id]: [...(current[patient.id] ?? patient.progressHistory), entry]
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    }));
  }, []);

  const value = useMemo(
    () => ({ getProgressHistory, getCurrentWeight, addWeightEntry }),
    [getProgressHistory, getCurrentWeight, addWeightEntry],
  );

  return <PatientSessionContext.Provider value={value}>{children}</PatientSessionContext.Provider>;
}

export function usePatientSession() {
  const context = useContext(PatientSessionContext);
  if (!context) throw new Error("usePatientSession must be used within PatientSessionProvider");
  return context;
}