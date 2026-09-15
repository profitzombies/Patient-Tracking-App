import type { Patient } from '@/data/mock-data';
import type { AttentionDigest, AttentionItem, AttentionReason } from '@/lib/office-alerts-api';

export const ATTENTION_DEMO_ANCHOR = '2026-08-22';
export const ATTENTION_DEMO_DATES = ['2026-08-22', '2026-08-21', '2026-08-20'];

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
const daysSince = (date: string, asOf: string) => Math.max(0, dayNumber(asOf) - dayNumber(date.slice(0, 10)));

export function buildDemoAttentionItems(patients: Patient[], asOf = ATTENTION_DEMO_ANCHOR): AttentionItem[] {
  return patients.flatMap((patient, index) => {
    if (patient.status === 'paused' || patient.status === 'cancelled') return [];
    const reasons: AttentionReason[] = [];
    const latestWeight = patient.progressHistory.at(-1)?.date;
    const weightDays = latestWeight ? daysSince(latestWeight, asOf) : null;
    const checkIn = patient.checkIns.at(-1)?.date;
    const checkInDays = checkIn ? daysSince(checkIn, asOf) : null;
    const latestActivity = patient.activity.map((item) => item.date).sort().at(-1);
    const activityDays = latestActivity ? daysSince(latestActivity, asOf) : null;
    if (weightDays === null || weightDays >= 7) reasons.push({ code: 'no_weight', label: 'No weight logged', days: weightDays });
    if (patient.adherence < 72 && index % 2 === 0) reasons.push({ code: 'no_meals', label: 'No meals logged', days: 3 + (index % 8) });
    if (patient.adherence < 68 && index % 3 === 0) reasons.push({ code: 'no_water', label: 'No water logged', days: 3 + (index % 6) });
    if (patient.stall) reasons.push({ code: 'weight_stalled', label: 'Weight stalled', days: Math.max(3, daysSince(patient.progressHistory.at(-1)?.date ?? patient.startDate, asOf)) });
    if (checkInDays === null || checkInDays >= 7) reasons.push({ code: 'check_in_overdue', label: 'Check-in overdue', days: checkInDays });
    if (activityDays !== null && activityDays >= 14) reasons.push({ code: 'no_activity_14d', label: 'No activity in 14 days', days: activityDays });
    if (!reasons.length) return [];
    return [{ patientId: patient.id, name: patient.name, reasons, signature: reasons.map((reason) => reason.code).sort().join(','), seen: false }];
  });
}

export function buildDemoDigest(patients: Patient[], date: string): AttentionDigest {
  const offset = ATTENTION_DEMO_DATES.indexOf(date);
  const all = buildDemoAttentionItems(patients, date);
  const items = offset <= 0 ? all : all.filter((_, index) => (index + offset) % 3 !== 0);
  return {
    digestDate: date,
    generatedAt: `${date}T12:00:00.000Z`,
    timeZone: 'America/Los_Angeles',
    flaggedCount: items.length,
    items,
  };
}