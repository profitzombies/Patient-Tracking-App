import type { Patient } from '@/data/mock-data';

export const DEMO_ATTENTION_ANCHOR_DATE = '2026-08-22';

function daysBetween(dateValue: string, asOfDate: string): number | null {
  const date = Date.parse(`${dateValue.slice(0, 10)}T12:00:00.000Z`);
  const asOf = Date.parse(`${asOfDate}T12:00:00.000Z`);
  if (!Number.isFinite(date) || !Number.isFinite(asOf)) return null;
  return Math.max(0, Math.floor((asOf - date) / 86_400_000));
}

/** Deterministic seeded-demo projection; it never consults the device clock. */
export function demoPatientNeedsAttention(
  patient: Patient,
  asOfDate = DEMO_ATTENTION_ANCHOR_DATE,
): boolean {
  if (patient.status === 'paused' || patient.status === 'cancelled') return false;
  const latestWeight = patient.progressHistory.at(-1)?.date ?? patient.startDate;
  const latestCheckIn = patient.checkIns[0]?.date ?? patient.startDate;
  const latestActivity = patient.activity[0]?.date ?? patient.startDate;
  const loggingLapsed = patient.adherence < 80 || patient.carePlan.protocolStatus === 'Needs outreach';
  const weightStalled = Boolean(patient.stall);
  return loggingLapsed ||
    weightStalled ||
    (daysBetween(latestWeight, asOfDate) ?? 0) >= 7 ||
    (daysBetween(latestCheckIn, asOfDate) ?? 0) >= 7 ||
    (daysBetween(latestActivity, asOfDate) ?? 0) >= 14;
}

export function demoAttentionCount(patients: Patient[]): number {
  return patients.filter(patient => demoPatientNeedsAttention(patient)).length;
}