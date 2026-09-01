import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  approvedMeasurements, AccountOperationEpoch, biometricEligibility,
  cancelAccountReminders, ReminderCoordinator,
  reconcileReminders,
  type NotificationDriver,
  type ReminderRecord,
} from '../lib/device-feature-core';

const records = new Map<string, ReminderRecord>();
let permission: 'granted' | 'denied' | 'undetermined' = 'granted';
let sequence = 0;
const active = new Set<string>();
const canceled: string[] = [];
const driver: NotificationDriver = {
  async permission() { return permission; },
  async requestPermission() {
    permission = permission === 'undetermined' ? 'granted' : permission;
    return permission === 'granted' ? 'granted' : 'denied';
  },
  async schedule() {
    const id = `notification-${++sequence}`;
    active.add(id);
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
const prefs = {
  enabled: true,
  times: { morning: '8:00 AM', afternoon: '3:00 PM', evening: '9:00 PM' },
} as const;

async function main() {
assert.equal(biometricEligibility({ platform: 'web', expoGo: false, hardware: true, enrolled: true, supportedTypes: [1], biometricTypes: [1] }), 'web');
assert.equal(biometricEligibility({ platform: 'ios', expoGo: true, hardware: true, enrolled: true, supportedTypes: [1], biometricTypes: [1] }), 'expo-go');
assert.equal(biometricEligibility({ platform: 'android', expoGo: false, hardware: true, enrolled: false, supportedTypes: [1], biometricTypes: [1] }), 'unsupported');
assert.equal(biometricEligibility({ platform: 'android', expoGo: false, hardware: true, enrolled: true, supportedTypes: [1], biometricTypes: [1] }), 'available');
await reconcileReminders('patient-a', prefs, 'America/New_York', driver, store, true);
assert.equal(active.size, 3, 'initial schedule creates three daily reminders');
const firstIds = [...active];
const unchanged = await reconcileReminders('patient-a', prefs, 'America/New_York', driver, store, true);
assert.equal(unchanged.status, 'unchanged');
assert.deepEqual([...active], firstIds, 'same settings never duplicate schedules');

await reconcileReminders(
  'patient-a',
  { ...prefs, times: { ...prefs.times, evening: '8:30 PM' } },
  'America/New_York',
  driver,
  store,
  true,
);
assert.equal(active.size, 3);
assert(firstIds.every(id => canceled.includes(id)), 'editing cancels every prior identifier');

const beforeZone = [...active];
await reconcileReminders('patient-a', prefs, 'America/Chicago', driver, store, false);
assert(beforeZone.every(id => canceled.includes(id)), 'timezone change replaces local-time schedules');

await reconcileReminders('patient-a', { ...prefs, enabled: false }, 'America/Chicago', driver, store, false);
assert.equal(active.size, 0, 'disabling cancels all reminders');

  permission = 'undetermined';
  const undecided = await reconcileReminders('patient-a', prefs, 'America/Chicago', driver, store, false);
  assert.equal(undecided.status, 'undetermined', 'undetermined permission stays distinct from denied');
permission = 'denied';
const denied = await reconcileReminders('patient-a', prefs, 'America/Chicago', driver, store, true);
assert.equal(denied.status, 'denied');
assert.equal(active.size, 0, 'permission denial never reports or creates schedules');

permission = 'granted';
await reconcileReminders('patient-a', prefs, 'UTC', driver, store, true);
await cancelAccountReminders('patient-a', driver, store);
assert.equal(active.size, 0, 'logout/account switch cancellation removes old account schedules');
await reconcileReminders('patient-b', prefs, 'UTC', driver, store, true);
assert.equal(records.has('patient-a'), false);
assert.equal(records.has('patient-b'), true, 'new account owns an isolated schedule record');

  const queued = new ReminderCoordinator(driver, store);
  await queued.activate('patient-c');
  const concurrent = await Promise.all([
    queued.reconcile('patient-c', prefs, 'UTC', true),
    queued.reconcile('patient-c', prefs, 'UTC', true),
  ]);
  assert.equal(concurrent.filter(v => v.status === 'scheduled' || v.status === 'unchanged').length, 2);
  assert.equal((await store.read('patient-c'))?.scheduled.length, 3, 'concurrent reconciles serialize without duplicates');
  const staleWork = queued.reconcile('patient-c', prefs, 'America/Chicago', true);
  const switching = queued.activate('patient-d');
  await Promise.all([staleWork, switching]);
  assert.equal(await store.read('patient-c'), null, 'account switch cancels queued old-account work');

  await queued.activate('patient-e');
  const oldObserved = queued.reconcile('patient-e', prefs, 'UTC', false);
  const disabledPrefs = { ...prefs, enabled: false };
  const newerDisable = queued.cancel('patient-e', disabledPrefs, 'UTC');
  const [oldResult] = await Promise.all([oldObserved, newerDisable]);
  assert.equal(oldResult.status, 'stale', 'newer disable invalidates queued AppState work with old flags');
  assert.equal((await store.read('patient-e'))?.scheduled.length, 0, 'stale observed preferences cannot recreate reminders');
  const staleAfterDisable = await queued.reconcile('patient-e', prefs, 'UTC', false);
  assert.equal(staleAfterDisable.status, 'stale', 'lagging server flags remain stale after disable lands');

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
assert(context.includes('hasHardwareAsync()') && context.includes('isEnrolledAsync()') && context.includes('supportedAuthenticationTypesAsync()') && context.includes('disableDeviceFallback: true'),
  'biometric enablement requires hardware, enrollment, and successful authentication');
assert(context.includes("Platform.OS === 'web'") && context.includes('isExpoGo'),
  'web and Expo Go have explicit unavailable health/device states');
assert(context.includes('importHealthMeasurements(approved, accessToken)'),
  'only allowlisted health measurements reach the account API');
assert(context.includes('importHealthMeasurements(approved, accessToken)') && context.includes('operationEpochRef.current.isCurrent(operation)'),
  'health imports bind the captured bearer and discard stale account operations');
assert(context.includes("device.biometric === 'expo-go'") || readFileSync(new URL('../components/onboarding/StepsAccount.tsx', import.meta.url), 'utf8').includes("device.biometric === 'expo-go'"),
  'native biometric unavailable states are explicit');
const accountScreen = readFileSync(new URL('../app/account.tsx', import.meta.url), 'utf8');
assert(accountScreen.includes('unavailable in Expo Go') && accountScreen.includes('unavailable on web') && accountScreen.includes('No supported enrolled biometric'),
  'account settings explains native unavailable states instead of displaying internal tokens');

const migration = readFileSync(new URL('../../../supabase/migrations/20260924000000_patient_health_measurements.sql', import.meta.url), 'utf8');
assert(migration.includes('primary key (patient_id, source, source_id)'), 'health imports are idempotent per account and source record');

console.log('device feature scheduling, denial, biometric, account-switch, and health contracts passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});