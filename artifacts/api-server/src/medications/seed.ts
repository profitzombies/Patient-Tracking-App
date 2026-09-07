/**
 * Onboarding → medication list. Runs once when setup completes: the program
 * choice and the reminder answers become the first medication records so the
 * phone's reminders and the office's adherence view start from the same
 * facts the patient just entered. An account that already has any
 * medication is left alone.
 */
import { randomUUID } from "node:crypto";
import { isClockTime, parseClockLabel, seedMedicationsFor, type MedicationInput } from "./schedule";
import { listMedications, upsertMedication } from "./store";

/** "8:00 AM" or "08:00" → "08:00"; anything else → null. */
function clockOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (isClockTime(value)) return value;
  return parseClockLabel(value);
}

/** Pure mapping from stored onboarding answers to the seed inputs. */
export function seedInputsFromAnswers(answers: Record<string, unknown>, startDate: string, makeId: () => string = randomUUID): MedicationInput[] {
  const dailyTimes = [answers.reminderMorning, answers.reminderAfternoon, answers.reminderEvening]
    .map(clockOf)
    .filter((t): t is string => t !== null);
  const injectionWeekday =
    typeof answers.injectionDay === "number" && Number.isInteger(answers.injectionDay) ? answers.injectionDay : null;
  return seedMedicationsFor(
    {
      programId: typeof answers.program === "string" ? answers.program : null,
      startDate,
      dailyTimes,
      injectionWeekday,
      injectionTime: clockOf(answers.injectionTime),
    },
    makeId,
  );
}

export async function seedMedicationsFromOnboarding(
  patientId: string,
  answers: unknown,
  startDate: string,
): Promise<{ seeded: number }> {
  const record = answers && typeof answers === "object" && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const inputs = seedInputsFromAnswers(record, startDate);
  if (inputs.length === 0) return { seeded: 0 };
  const existing = await listMedications(patientId);
  if (existing.length > 0) return { seeded: 0 };
  for (const input of inputs) await upsertMedication(patientId, input, { source: "onboarding" });
  return { seeded: inputs.length };
}
