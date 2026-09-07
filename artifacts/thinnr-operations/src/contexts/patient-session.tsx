import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Patient, WeightEntry } from "@/data/mock-data";
import type { MeasurementVisit } from "@/lib/body-measurements";

interface PatientSessionValue {
  getProgressHistory: (patient: Patient) => WeightEntry[];
  getCurrentWeight: (patient: Patient) => number;
  addWeightEntry: (patient: Patient, entry: WeightEntry) => void;
  /** Seeded measurement visits with this session's logged visits layered on and removed ones dropped. */
  getBodyMeasurements: (patient: Patient) => MeasurementVisit[];
  addMeasurementVisit: (patient: Patient, visit: MeasurementVisit) => void;
  removeMeasurementVisit: (patient: Patient, visitId: string) => void;
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

  const [visitOverrides, setVisitOverrides] = useState<Record<string, MeasurementVisit[]>>({});

  const getBodyMeasurements = useCallback(
    (patient: Patient) => visitOverrides[patient.id] ?? patient.bodyMeasurements,
    [visitOverrides],
  );

  const addMeasurementVisit = useCallback((patient: Patient, visit: MeasurementVisit) => {
    setVisitOverrides((current) => ({
      ...current,
      [patient.id]: [...(current[patient.id] ?? patient.bodyMeasurements), visit],
    }));
  }, []);

  const removeMeasurementVisit = useCallback((patient: Patient, visitId: string) => {
    setVisitOverrides((current) => ({
      ...current,
      [patient.id]: (current[patient.id] ?? patient.bodyMeasurements).filter((visit) => visit.id !== visitId),
    }));
  }, []);

  const value = useMemo(
    () => ({ getProgressHistory, getCurrentWeight, addWeightEntry, getBodyMeasurements, addMeasurementVisit, removeMeasurementVisit }),
    [getProgressHistory, getCurrentWeight, addWeightEntry, getBodyMeasurements, addMeasurementVisit, removeMeasurementVisit],
  );

  return <PatientSessionContext.Provider value={value}>{children}</PatientSessionContext.Provider>;
}

export function usePatientSession() {
  const context = useContext(PatientSessionContext);
  if (!context) throw new Error("usePatientSession must be used within PatientSessionProvider");
  return context;
}