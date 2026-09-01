export type ReminderSlot = 'morning' | 'afternoon' | 'evening';

export interface ReminderPrefs {
  enabled: boolean;
  times: Record<ReminderSlot, string>;
}

export interface ScheduledReminder {
  slot: ReminderSlot;
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
  schedule(slot: ReminderSlot, hour: number, minute: number): Promise<string>;
  cancel(identifier: string): Promise<void>;
}

export type ReminderResult =
  | { status: 'scheduled' | 'unchanged' | 'disabled'; count: number }
  | { status: 'denied' | 'undetermined' | 'stale'; count: 0 };

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

function signatureFor(prefs: ReminderPrefs, timezone: string): string {
  return JSON.stringify([timezone, prefs.enabled, prefs.times.morning, prefs.times.afternoon, prefs.times.evening]);
}

/** Cancel-first replacement makes a retry idempotent and prevents duplicate daily alarms. */
export async function reconcileReminders(
  accountId: string,
  prefs: ReminderPrefs,
  timezone: string,
  driver: NotificationDriver,
  store: ReminderStore,
  requestPermission: boolean,
): Promise<ReminderResult> {
  const previous = await store.read(accountId);
  const signature = signatureFor(prefs, timezone);
  if (previous?.signature === signature) {
    return { status: prefs.enabled ? 'unchanged' : 'disabled', count: previous.scheduled.length };
  }
  for (const item of previous?.scheduled ?? []) await driver.cancel(item.identifier);
  await store.write(accountId, null);
  if (!prefs.enabled) {
    await store.write(accountId, { accountId, timezone, signature, scheduled: [] });
    return { status: 'disabled', count: 0 };
  }
  let permission = await driver.permission();
  if (permission !== 'granted' && requestPermission) permission = await driver.requestPermission();
  if (permission !== 'granted') return { status: permission, count: 0 };

  const scheduled: ScheduledReminder[] = [];
  try {
    for (const slot of ['morning', 'afternoon', 'evening'] as const) {
      const clock = parseClock(prefs.times[slot]);
      if (!clock) throw new Error(`Invalid ${slot} reminder time.`);
      scheduled.push({ slot, identifier: await driver.schedule(slot, clock.hour, clock.minute) });
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
  private desired = new Map<string, { signature: string; revision: number }>();
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
    prefs: ReminderPrefs,
    timezone: string,
    requestPermission: boolean,
    authoritative = false,
  ): Promise<ReminderResult> {
    const generation = this.generation;
    const signature = signatureFor(prefs, timezone);
    const current = this.desired.get(accountId);
    if (!authoritative && current && current.signature !== signature) {
      return Promise.resolve({ status: 'stale', count: 0 });
    }
    const desired = authoritative
      ? { signature, revision: (current?.revision ?? 0) + 1 }
      : current ?? { signature, revision: 0 };
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
      return reconcileReminders(accountId, prefs, timezone, this.driver, this.store, requestPermission);
    });
  }

  cancel(accountId: string, disabledPrefs: ReminderPrefs, timezone: string): Promise<void> {
    const generation = this.generation;
    const signature = signatureFor(disabledPrefs, timezone);
    const current = this.desired.get(accountId);
    const desired = { signature, revision: (current?.revision ?? 0) + 1 };
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