import { isClockTime, medicationLine, normalizeTimes, type MedicationRecord } from './medication-schedule';

/**
 * One local notification to keep on the device: a daily alarm (weekday
 * null) or a weekly one (weekday 0 = Sunday … 6 = Saturday), naming the
 * medication and dose in its content. `key` is stable across reconciles so
 * a plan can be diffed by signature.
 */
export interface ReminderItem {
  key: string;
  title: string;
  body: string;
  hour: number;
  minute: number;
  weekday: number | null;
  data: ReminderData;
}

/** Payload every medication reminder carries so a tap or action can log the dose. */
export interface ReminderData {
  feature: 'medication-reminder';
  medicationId: string;
  dueTime: string;
  weekday: number | null;
}

export interface ReminderPlan {
  enabled: boolean;
  items: ReminderItem[];
}

export interface ScheduledReminder {
  key: string;
  identifier: string;
}

export interface ReminderRecord {
  accountId: string;
  timezone: string;
  signature: string;
  scheduled: ScheduledReminder[];
}

export interface ReminderStore {
  read(accountId: string): Promise<ReminderRecord | null>;
  write(accountId: string, value: ReminderRecord | null): Promise<void>;
}

export interface NotificationDriver {
  permission(): Promise<'granted' | 'denied' | 'undetermined'>;
  requestPermission(): Promise<'granted' | 'denied'>;
  schedule(item: ReminderItem): Promise<string>;
  cancel(identifier: string): Promise<void>;
}

export type ReminderResult =
  | { status: 'scheduled' | 'unchanged' | 'disabled'; count: number }
  | { status: 'denied' | 'undetermined' | 'stale'; count: 0 };

/** Notification action identifiers on a medication reminder. */
export const REMINDER_ACTION_TAKEN = 'taken';
export const REMINDER_ACTION_SKIPPED = 'skipped';
export const REMINDER_CATEGORY = 'medication-dose';

export function parseClock(value: string): { hour: number; minute: number } | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return { hour, minute };
}

/**
 * The device reminders a medication list calls for on `todayKey`: one
 * repeating alarm per (medication, time), weekly ones pinned to the
 * medication's weekday. Stopped medications and ones not started yet are
 * left out; because the plan is re-derived on every foreground, a start or
 * stop date crossing midnight changes the signature and the schedules
 * follow. Ordering is deterministic so the signature is too.
 */
export function reminderPlanFor(
  medications: readonly MedicationRecord[],
  enabled: boolean,
  todayKey: string,
): ReminderPlan {
  const items: ReminderItem[] = [];
  const sorted = [...medications].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const medication of sorted) {
    if (medication.stopDate && medication.stopDate < todayKey) continue;
    if (medication.startDate > todayKey) continue;
    const weekday =
      medication.scheduleKind === 'weekly' &&
      medication.weekday !== null &&
      medication.weekday >= 0 &&
      medication.weekday <= 6
        ? medication.weekday
        : null;
    if (medication.scheduleKind === 'weekly' && weekday === null) continue;
    for (const time of normalizeTimes(medication.times)) {
      if (!isClockTime(time)) continue;
      const [hour, minute] = time.split(':').map(Number);
      items.push({
        key: `${medication.id}:${time}${weekday === null ? '' : `:w${weekday}`}`,
        title: weekday === null ? 'Time for your medication' : 'Time for your weekly dose',
        body: medicationLine(medication),
        hour,
        minute,
        weekday,
        data: { feature: 'medication-reminder', medicationId: medication.id, dueTime: time, weekday },
      });
    }
  }
  return { enabled, items };
}

function signatureFor(plan: ReminderPlan, timezone: string): string {
  return JSON.stringify([
    timezone,
    plan.enabled,
    plan.items.map(item => [item.key, item.title, item.body, item.hour, item.minute, item.weekday]),
  ]);
}

/** Cancel-first replacement makes a retry idempotent and prevents duplicate alarms. */
export async function reconcileReminders(
  accountId: string,
  plan: ReminderPlan,
  timezone: string,
  driver: NotificationDriver,
  store: ReminderStore,
  requestPermission: boolean,
): Promise<ReminderResult> {
  const previous = await store.read(accountId);
  const signature = signatureFor(plan, timezone);
  if (previous?.signature === signature) {
    return { status: plan.enabled ? 'unchanged' : 'disabled', count: previous.scheduled.length };
  }
  for (const item of previous?.scheduled ?? []) await driver.cancel(item.identifier);
  await store.write(accountId, null);
  if (!plan.enabled) {
    await store.write(accountId, { accountId, timezone, signature, scheduled: [] });
    return { status: 'disabled', count: 0 };
  }
  let permission = await driver.permission();
  if (permission !== 'granted' && requestPermission) permission = await driver.requestPermission();
  if (permission !== 'granted') return { status: permission, count: 0 };

  const scheduled: ScheduledReminder[] = [];
  try {
    for (const item of plan.items) {
      scheduled.push({ key: item.key, identifier: await driver.schedule(item) });
    }
  } catch (error) {
    for (const item of scheduled) await driver.cancel(item.identifier);
    throw error;
  }
  await store.write(accountId, { accountId, timezone, signature, scheduled });
  return { status: 'scheduled', count: scheduled.length };
}

/** One FIFO rail for device notifications. Account generations ensure late
 * hydration/app-state work cannot recreate an old account's schedules. */
export class ReminderCoordinator {
  private chain: Promise<void> = Promise.resolve();
  private active: string | null = null;
  private generation = 0;
  /**
   * Latest intent per account. `revision` orders queued work so an older
   * reconcile can never land over a newer one; `pinnedEnabled` remembers the
   * last user-initiated (authoritative) enable/disable so that lagging
   * server flags cannot undo it, while ordinary plan changes (medication
   * edits, day rollovers, timezone changes) always supersede the prior plan.
   */
  private desired = new Map<string, { signature: string; revision: number; pinnedEnabled: boolean | null }>();
  constructor(private readonly driver: NotificationDriver, private readonly store: ReminderStore) {}

  activate(accountId: string | null): Promise<void> {
    const prior = this.active;
    this.active = accountId;
    this.generation += 1;
    if (accountId) this.desired.delete(accountId);
    const generation = this.generation;
    return this.enqueue(async () => {
      if (prior && prior !== accountId) await cancelAccountReminders(prior, this.driver, this.store);
      // Do not let a stale activation overwrite a newer account's state.
      if (generation !== this.generation) return;
    });
  }

  reconcile(
    accountId: string,
    plan: ReminderPlan,
    timezone: string,
    requestPermission: boolean,
    authoritative = false,
  ): Promise<ReminderResult> {
    const generation = this.generation;
    const signature = signatureFor(plan, timezone);
    const current = this.desired.get(accountId);
    // Observed (server-flag) plans that contradict the user's latest local
    // enable/disable are lagging data, not a new intent: refuse them.
    if (!authoritative && current && current.pinnedEnabled !== null && plan.enabled !== current.pinnedEnabled) {
      return Promise.resolve({ status: 'stale', count: 0 });
    }
    const changed = !current || current.signature !== signature || authoritative;
    const desired = {
      signature,
      revision: changed ? (current?.revision ?? 0) + 1 : current.revision,
      pinnedEnabled: authoritative ? plan.enabled : current?.pinnedEnabled ?? null,
    };
    this.desired.set(accountId, desired);
    return this.enqueue(async () => {
      const latest = this.desired.get(accountId);
      if (
        this.active !== accountId ||
        this.generation !== generation ||
        !latest ||
        latest.revision !== desired.revision ||
        latest.signature !== signature
      ) return { status: 'stale', count: 0 };
      return reconcileReminders(accountId, plan, timezone, this.driver, this.store, requestPermission);
    });
  }

  cancel(accountId: string, disabledPlan: ReminderPlan, timezone: string): Promise<void> {
    const generation = this.generation;
    const signature = signatureFor({ ...disabledPlan, enabled: false }, timezone);
    const current = this.desired.get(accountId);
    const desired = { signature, revision: (current?.revision ?? 0) + 1, pinnedEnabled: false };
    this.desired.set(accountId, desired);
    return this.enqueue(async () => {
      const latest = this.desired.get(accountId);
      if (
        this.generation !== generation ||
        this.active !== accountId ||
        !latest ||
        latest.revision !== desired.revision ||
        latest.signature !== signature
      ) return;
      await cancelAccountReminders(accountId, this.driver, this.store);
      await this.store.write(accountId, {
        accountId,
        timezone,
        signature,
        scheduled: [],
      });
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Captured epochs make native prompts and reads harmless after account changes. */
export class AccountOperationEpoch {
  private accountId: string | null = null;
  private generation = 0;

  activate(accountId: string | null): void {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    this.generation += 1;
  }

  capture(accountId: string): { accountId: string; generation: number } {
    return { accountId, generation: this.generation };
  }

  isCurrent(operation: { accountId: string; generation: number }): boolean {
    return this.accountId === operation.accountId && this.generation === operation.generation;
  }
}

export async function cancelAccountReminders(
  accountId: string,
  driver: NotificationDriver,
  store: ReminderStore,
): Promise<void> {
  const previous = await store.read(accountId);
  for (const item of previous?.scheduled ?? []) await driver.cancel(item.identifier);
  await store.write(accountId, null);
}

export interface HealthMeasurement {
  sourceId: string;
  kind: 'weight_lb' | 'steps';
  value: number;
  measuredAt: string;
  source: 'apple_health' | 'health_connect';
}

export function biometricEligibility(input: {
  platform: string;
  expoGo: boolean;
  hardware: boolean;
  enrolled: boolean;
  supportedTypes: number[];
  biometricTypes: number[];
}): 'available' | 'web' | 'expo-go' | 'unsupported' {
  if (input.platform === 'web') return 'web';
  if (input.platform === 'ios' && input.expoGo) return 'expo-go';
  if (input.platform !== 'ios' && input.platform !== 'android') return 'unsupported';
  if (!input.hardware || !input.enrolled || !input.supportedTypes.some(type => input.biometricTypes.includes(type))) {
    return 'unsupported';
  }
  return 'available';
}

export function approvedMeasurements(values: HealthMeasurement[]): HealthMeasurement[] {
  const seen = new Set<string>();
  const now = Date.now();
  const earliest = now - 31 * 86400000;
  const latest = now + 5 * 60 * 1000;
  return values.filter(item => {
    const measured = Date.parse(item.measuredAt);
    const sourceKey = `${item.source}:${item.sourceId}`;
    if (
      seen.has(sourceKey) ||
      !Number.isFinite(item.value) ||
      item.value < 0 ||
      (item.kind === 'weight_lb' && (item.value < 40 || item.value > 1500)) ||
      (item.kind === 'steps' && (!Number.isInteger(item.value) || item.value > 250000)) ||
      !Number.isFinite(measured) || measured < earliest || measured > latest
    ) return false;
    seen.add(sourceKey);
    return true;
  });
}