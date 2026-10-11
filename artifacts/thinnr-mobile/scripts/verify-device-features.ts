import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  approvedMeasurements, AccountOperationEpoch, biometricEligibility, biometricLockedForAccount,
  cancelAccountReminders, ReminderCoordinator,
  isDeviceLocked, reconcileReminders, reminderPlanFor, webBiometricHydration,
  type NotificationDriver,
  type ReminderItem,
  type ReminderRecord,
} from '../lib/device-feature-core';
import { shiftDateKey, type MedicationRecord } from '../lib/medication-schedule';

const records = new Map<string, ReminderRecord>();
let permission: 'granted' | 'denied' | 'undetermined' = 'granted';
let sequence = 0;
const active = new Map<string, ReminderItem>();
const canceled: string[] = [];
const driver: NotificationDriver = {
  async permission() { return permission; },
  async requestPermission() {
    permission = permission === 'undetermined' ? 'granted' : permission;
    return permission === 'granted' ? 'granted' : 'denied';
  },
  async schedule(item) {
    const id = `notification-${++sequence}`;
    active.set(id, item);
    return id;
  },
  async cancel(id) {
    canceled.push(id);
    active.delete(id);
  },
};
const store = {
  async read(id: string) { return records.get(id) ?? null; },
  async write(id: string, value: ReminderRecord | null) {
    if (value) records.set(id, value);
    else records.delete(id);
  },
};

const TODAY = '2026-09-07';
const base = { notes: null, stopDate: null, source: 'patient' as const, version: 1, updatedAt: '2026-09-01T00:00:00.000Z' };
const drops: MedicationRecord = {
  ...base, id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'THINNR Protocol drops', form: 'drops', dose: '1 mL under the tongue',
  scheduleKind: 'daily', times: ['08:00', '15:00', '22:00'], weekday: null, startDate: '2026-09-01',
};
const injection: MedicationRecord = {
  ...base, id: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'GLP-1 injection', form: 'injection', dose: '0.5 mg',
  scheduleKind: 'weekly', times: ['09:00'], weekday: 3, startDate: '2026-09-01',
};
const meds = [drops, injection];
const plan = reminderPlanFor(meds, true, TODAY);
const disabledPlan = reminderPlanFor(meds, false, TODAY);

async function main() {
// ── Plan derivation: every reminder names its medication, on its own days ──
assert.equal(plan.items.length, 4, 'three daily drops alarms plus one weekly injection alarm');
assert.deepEqual(plan.items.map(i => [i.hour, i.minute, i.weekday]), [[8, 0, null], [15, 0, null], [22, 0, null], [9, 0, 3]]);
assert(plan.items.slice(0, 3).every(i => i.body === 'THINNR Protocol drops · 1 mL under the tongue'), 'daily alarms carry name and dose');
assert.equal(plan.items[3].body, 'GLP-1 injection · 0.5 mg');
assert.equal(plan.items[3].title, 'Time for your weekly dose');
assert.deepEqual(plan.items[3].data, { feature: 'medication-reminder', medicationId: injection.id, dueTime: '09:00', weekday: 3 });
assert.equal(reminderPlanFor([{ ...drops, stopDate: '2026-09-06' }], true, TODAY).items.length, 0, 'a stopped medication schedules nothing');
assert.equal(reminderPlanFor([{ ...drops, stopDate: TODAY }], true, TODAY).items.length, 3, 'stop date is inclusive');
assert.equal(reminderPlanFor([{ ...drops, startDate: '2026-09-08' }], true, TODAY).items.length, 0, 'a future start schedules nothing yet');
assert.equal(reminderPlanFor([{ ...injection, weekday: null }], true, TODAY).items.length, 0, 'a weekly record without a day cannot fire');
assert.equal(reminderPlanFor([{ ...drops, times: ['22:00', '08:00', '08:00'] }], true, TODAY).items.map(i => i.hour).join(','), '8,22', 'times are deduplicated and ordered');

assert.equal(biometricEligibility({ platform: 'web', expoGo: false, hardware: true, enrolled: true, supportedTypes: [1], biometricTypes: [1] }), 'web');
const webHydration = webBiometricHydration('patient-web');
assert.equal(
  isDeviceLocked('patient-web', webHydration.loadedFor, webHydration.locked),
  false,
  'a real web account is marked hydrated and never enters the native biometric lock',
);
assert.equal(isDeviceLocked('patient-native', 'patient-native', true), true,
  'a native account with enabled biometrics remains locked after hydration');
assert.equal(isDeviceLocked('patient-b', 'patient-a', false), true,
  'an account swap remains locked until the new native account has hydrated');
assert.equal(biometricEligibility({ platform: 'ios', expoGo: true, hardware: true, enrolled: true, supportedTypes: [1], biometricTypes: [1] }), 'expo-go');
assert.equal(biometricEligibility({ platform: 'android', expoGo: false, hardware: true, enrolled: false, supportedTypes: [1], biometricTypes: [1] }), 'unsupported');
assert.equal(biometricEligibility({ platform: 'android', expoGo: false, hardware: true, enrolled: true, supportedTypes: [1], biometricTypes: [1] }), 'available');
assert.equal(
  biometricLockedForAccount('web', 'real-patient-a', null, true),
  false,
  'a real web patient is explicitly unlocked before the hydration effect commits',
);
assert.equal(
  biometricLockedForAccount('web', 'real-patient-b', 'real-patient-a', true),
  false,
  'switching real web accounts never inherits the prior account biometric gate',
);
assert.equal(
  biometricLockedForAccount('ios', 'real-patient-b', 'real-patient-a', false),
  true,
  'native account switches remain locked until that account setting loads',
);
assert.equal(
  biometricLockedForAccount('android', 'real-patient-b', 'real-patient-b', true),
  true,
  'native enabled biometrics retain the default lock',
);
await reconcileReminders('patient-a', plan, 'America/New_York', driver, store, true);
assert.equal(active.size, 4, 'initial schedule creates one alarm per medication time');
assert.deepEqual([...active.values()].map(i => i.weekday), [null, null, null, 3], 'weekly alarms schedule with their weekday');
const firstIds = [...active.keys()];
const unchanged = await reconcileReminders('patient-a', plan, 'America/New_York', driver, store, true);
assert.equal(unchanged.status, 'unchanged');
assert.deepEqual([...active.keys()], firstIds, 'same list never duplicates schedules');

const edited = reminderPlanFor([{ ...drops, times: ['08:00', '15:00', '20:30'] }, injection], true, TODAY);
await reconcileReminders('patient-a', edited, 'America/New_York', driver, store, true);
assert.equal(active.size, 4);
assert(firstIds.every(id => canceled.includes(id)), 'editing a time cancels every prior identifier');
assert([...active.values()].some(i => i.hour === 20 && i.minute === 30), 'the edited time is scheduled');

const stoppedPlan = reminderPlanFor([{ ...drops, times: ['08:00', '15:00', '20:30'] }, { ...injection, stopDate: '2026-09-06' }], true, TODAY);
await reconcileReminders('patient-a', stoppedPlan, 'America/New_York', driver, store, true);
assert.equal(active.size, 3, 'stopping a medication removes its alarm');
assert([...active.values()].every(i => i.weekday === null), 'the weekly alarm is gone');

const beforeZone = [...active.keys()];
await reconcileReminders('patient-a', stoppedPlan, 'America/Chicago', driver, store, false);
assert(beforeZone.every(id => canceled.includes(id)), 'timezone change replaces local-time schedules');

await reconcileReminders('patient-a', disabledPlan, 'America/Chicago', driver, store, false);
assert.equal(active.size, 0, 'disabling cancels all reminders');

await reconcileReminders('patient-a', plan, 'America/Chicago', driver, store, false);
await reconcileReminders('patient-a', reminderPlanFor([], true, TODAY), 'America/Chicago', driver, store, false);
assert.equal(active.size, 0, 'an emptied medication list cancels every alarm while reminders stay enabled');

  permission = 'undetermined';
  const undecided = await reconcileReminders('patient-a', plan, 'America/Chicago', driver, store, false);
  assert.equal(undecided.status, 'undetermined', 'undetermined permission stays distinct from denied');
permission = 'denied';
const denied = await reconcileReminders('patient-a', plan, 'America/Chicago', driver, store, true);
assert.equal(denied.status, 'denied');
assert.equal(active.size, 0, 'permission denial never reports or creates schedules');

permission = 'granted';
await reconcileReminders('patient-a', plan, 'UTC', driver, store, true);
await cancelAccountReminders('patient-a', driver, store);
assert.equal(active.size, 0, 'logout/account switch cancellation removes old account schedules');
await reconcileReminders('patient-b', plan, 'UTC', driver, store, true);
assert.equal(records.has('patient-a'), false);
assert.equal(records.has('patient-b'), true, 'new account owns an isolated schedule record');

  const queued = new ReminderCoordinator(driver, store);
  await queued.activate('patient-c');
  const concurrent = await Promise.all([
    queued.reconcile('patient-c', plan, 'UTC', true),
    queued.reconcile('patient-c', plan, 'UTC', true),
  ]);
  assert.equal(concurrent.filter(v => v.status === 'scheduled' || v.status === 'unchanged').length, 2);
  assert.equal((await store.read('patient-c'))?.scheduled.length, 4, 'concurrent reconciles serialize without duplicates');
  const staleWork = queued.reconcile('patient-c', plan, 'America/Chicago', true);
  const switching = queued.activate('patient-d');
  await Promise.all([staleWork, switching]);
  assert.equal(await store.read('patient-c'), null, 'account switch cancels queued old-account work');

  await queued.activate('patient-e');
  const oldObserved = queued.reconcile('patient-e', plan, 'UTC', false);
  const newerDisable = queued.cancel('patient-e', disabledPlan, 'UTC');
  const [oldResult] = await Promise.all([oldObserved, newerDisable]);
  assert.equal(oldResult.status, 'stale', 'newer disable invalidates queued AppState work with old flags');
  assert.equal((await store.read('patient-e'))?.scheduled.length, 0, 'stale observed preferences cannot recreate reminders');
  const staleAfterDisable = await queued.reconcile('patient-e', plan, 'UTC', false);
  assert.equal(staleAfterDisable.status, 'stale', 'lagging server flags remain stale after disable lands');
  const listChanged = await queued.reconcile('patient-e', reminderPlanFor([drops], true, TODAY), 'UTC', false, true);
  assert.equal(listChanged.status, 'scheduled', 'an authoritative list change supersedes the disable and reschedules');
  assert.equal((await store.read('patient-e'))?.scheduled.length, 3);

  // Records-derived reminders after the initial enable: ordinary (non-authoritative)
  // plan changes must supersede the scheduled plan, not be refused as stale.
  {
    const lifecycle = new ReminderCoordinator(driver, store);
    await lifecycle.activate('patient-f');
    const enabled = await lifecycle.reconcile('patient-f', reminderPlanFor([drops], true, TODAY), 'UTC', true, true);
    assert.equal(enabled.status, 'scheduled');
    assert.equal((await store.read('patient-f'))?.scheduled.length, 3, 'enable schedules the daily drops');
    const added = await lifecycle.reconcile('patient-f', reminderPlanFor([drops, injection], true, TODAY), 'UTC', false);
    assert.equal(added.status, 'scheduled', 'adding a medication after enable reschedules without re-enabling');
    assert.equal((await store.read('patient-f'))?.scheduled.length, 4, 'added weekly injection gains its schedule');
    const edited = await lifecycle.reconcile('patient-f', reminderPlanFor([{ ...drops, times: ['09:00', '21:00'] }, injection], true, TODAY), 'UTC', false);
    assert.equal(edited.status, 'scheduled', 'editing dose times reschedules');
    assert.equal((await store.read('patient-f'))?.scheduled.length, 3, 'edited record has exactly its new times');
    const stopped = await lifecycle.reconcile('patient-f', reminderPlanFor([{ ...drops, times: ['09:00', '21:00'], stopDate: TODAY }, injection], true, shiftDateKey(TODAY, 1)), 'UTC', false);
    assert.equal(stopped.status, 'scheduled', 'crossing a stop date on the day rollover reschedules');
    assert.equal((await store.read('patient-f'))?.scheduled.length, 1, 'a stopped record loses its schedules after its last day');
    const moved = await lifecycle.reconcile('patient-f', reminderPlanFor([{ ...drops, times: ['09:00', '21:00'], stopDate: TODAY }, injection], true, shiftDateKey(TODAY, 1)), 'America/Chicago', false);
    assert.equal(moved.status, 'scheduled', 'a foreground timezone change reschedules');
    const same = await lifecycle.reconcile('patient-f', reminderPlanFor([{ ...drops, times: ['09:00', '21:00'], stopDate: TODAY }, injection], true, shiftDateKey(TODAY, 1)), 'America/Chicago', false);
    assert.equal(same.status, 'unchanged', 'an identical plan is a no-op');
    const laggingOff = await lifecycle.reconcile('patient-f', reminderPlanFor([injection], false, shiftDateKey(TODAY, 1)), 'America/Chicago', false);
    assert.equal(laggingOff.status, 'stale', 'observed flags that contradict the local enable are still refused');
    assert.equal((await store.read('patient-f'))?.scheduled.length, 1, 'refused lagging flags leave the schedules alone');
  }

  const epochs = new AccountOperationEpoch();
  epochs.activate('patient-a');
  const nativePromptForA = epochs.capture('patient-a');
  epochs.activate('patient-b');
  assert.equal(epochs.isCurrent(nativePromptForA), false, 'account switch invalidates in-flight biometric and health operations');
  const nativePromptForB = epochs.capture('patient-b');
  assert.equal(epochs.isCurrent(nativePromptForB), true, 'current account native operation stays valid');

const health = approvedMeasurements([
  { sourceId: 'w1', kind: 'weight_lb', value: 180, measuredAt: new Date().toISOString(), source: 'apple_health' },
  { sourceId: 'w1', kind: 'weight_lb', value: 180, measuredAt: new Date().toISOString(), source: 'apple_health' },
  { sourceId: 'w1', kind: 'weight_lb', value: 181, measuredAt: new Date().toISOString(), source: 'health_connect' },
  { sourceId: 's1', kind: 'steps', value: 9000, measuredAt: new Date().toISOString(), source: 'health_connect' },
  { sourceId: 'bad', kind: 'steps', value: -1, measuredAt: 'bad', source: 'health_connect' },
]);
assert.deepEqual(health.map(item => `${item.source}:${item.sourceId}`), ['apple_health:w1', 'health_connect:w1', 'health_connect:s1'],
  'health allowlist validates values and deduplicates by the storage source key');

const context = readFileSync(new URL('../context/DeviceFeaturesContext.tsx', import.meta.url), 'utf8');
assert(
  context.includes("if (Platform.OS === 'web')") &&
  context.includes('setBiometricLoadedFor(accountId)') &&
  context.includes('biometricLockedForAccount(Platform.OS'),
  'the real provider marks every web account loaded and derives an always-unlocked web gate',
);
assert(context.includes('SchedulableTriggerInputTypes.WEEKLY') && context.includes('SchedulableTriggerInputTypes.DAILY'),
  'device reminders schedule weekly and daily triggers from the medication plan');
assert(context.includes('weekday: item.weekday + 1'), 'Expo weekday (1 = Sunday) is derived from the record weekday (0 = Sunday)');
assert(!context.includes('opensAppToForeground: false') && (context.match(/opensAppToForeground: true/g) ?? []).length === 2,
  'Taken/Skip actions must foreground the app: no background response task exists, so a background-only action is dropped while the app is suspended');
assert(context.includes('REMINDER_ACTION_TAKEN') && context.includes('REMINDER_ACTION_SKIPPED') && context.includes('setNotificationCategoryAsync'),
  'reminders expose Taken / Skip actions through a notification category');
assert(context.includes('AppState.addEventListener') && context.includes('planRef.current'),
  'foreground reconciliation reuses the latest medication plan (timezone changes)');
const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
assert(layout.includes('reminderDoseFromResponse') && layout.includes('logDose({ ...dose.log, status: dose.status })'),
  'reminder taps and actions log the dose through the patient context');
assert(context.includes('hasHardwareAsync()') && context.includes('isEnrolledAsync()') && context.includes('supportedAuthenticationTypesAsync()') && context.includes('disableDeviceFallback: true'),
  'biometric enablement requires hardware, enrollment, and successful authentication');
assert(context.includes("Platform.OS === 'web'") && context.includes('isExpoGo'),
  'web and Expo Go have explicit unavailable health/device states');
assert(context.includes('importHealthMeasurements(approved, accessToken)'),
  'only allowlisted health measurements reach the account API');
assert(context.includes('importHealthMeasurements(approved, accessToken)') && context.includes('operationEpochRef.current.isCurrent(operation)'),
  'health imports bind the captured bearer and discard stale account operations');
assert(context.includes("device.biometric === 'expo-go'") || readFileSync(new URL('../app/account.tsx', import.meta.url), 'utf8').includes("device.biometric === 'expo-go'"),
  'native biometric unavailable states are explicit');
const accountScreen = readFileSync(new URL('../app/account.tsx', import.meta.url), 'utf8');
assert(accountScreen.includes('unavailable in Expo Go') && accountScreen.includes('unavailable on web') && accountScreen.includes('No supported enrolled biometric'),
  'account settings explains native unavailable states instead of displaying internal tokens');

const migration = readFileSync(new URL('../../../supabase/migrations/20260924000000_patient_health_measurements.sql', import.meta.url), 'utf8');
assert(migration.includes('primary key (patient_id, source, source_id)'), 'health imports are idempotent per account and source record');

console.log('device feature per-medication scheduling, denial, biometric, account-switch, and health contracts passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
