/**
 * Turns a tapped medication reminder (or one of its Taken / Skip actions)
 * into the dose the patient meant. Pure so the response bridge and its
 * suite share one reading of the payload.
 */
import {
  REMINDER_ACTION_SKIPPED,
  REMINDER_ACTION_TAKEN,
  type ReminderData,
} from './device-feature-core';
import { isClockTime, localDateKey } from './medication-schedule';

export interface ReminderDoseIntent {
  /** null = the patient tapped the reminder body (open the check-in card). */
  status: 'taken' | 'skipped' | null;
  log: { medicationId: string; dueDate: string; dueTime: string; source: 'reminder' };
}

interface ResponseLike {
  actionIdentifier: string;
  notification: { date: number; request: { content: { data?: unknown } } };
}

/**
 * expo-notifications reports the fire time in milliseconds on Android but in
 * seconds on iOS (NotificationRecords.swift stores timeIntervalSince1970
 * unscaled); anything below ~1973 in ms is a seconds value.
 */
export function firedAtOf(date: number | null | undefined): Date {
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return new Date();
  return new Date(date < 1e11 ? date * 1000 : date);
}

export function reminderDoseFromResponse(response: ResponseLike, timeZone: string | null | undefined): ReminderDoseIntent | null {
  const data = response.notification.request.content.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Partial<ReminderData> & Record<string, unknown>;
  if (raw.feature !== 'medication-reminder') return null;
  if (typeof raw.medicationId !== 'string' || !isClockTime(raw.dueTime)) return null;
  // The due day is the local day the reminder fired, not the day the
  // patient got around to tapping it (a 9 PM dose answered after midnight
  // still belongs to yesterday).
  const firedAt = firedAtOf(response.notification.date);
  const dueDate = localDateKey(firedAt, timeZone);
  const status =
    response.actionIdentifier === REMINDER_ACTION_TAKEN
      ? 'taken'
      : response.actionIdentifier === REMINDER_ACTION_SKIPPED
        ? 'skipped'
        : null;
  return { status, log: { medicationId: raw.medicationId, dueDate, dueTime: raw.dueTime, source: 'reminder' } };
}
