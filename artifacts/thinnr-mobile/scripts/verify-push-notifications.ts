import assert from 'node:assert/strict';
import { AccountOperationEpoch } from '../lib/device-feature-core';
import {
  buildNotificationPrefsPatch,
  getOrCreateDeviceId,
  parseNotificationPrefs,
  pushAvailability,
  registerForPush,
  resolveNotificationRoute,
  unregisterPush,
  type PushRegistrationDriver,
} from '../lib/push-notification-core';
import { isOutreachMessageId } from '../data/stall-nudge';

async function main() {
  assert.equal(pushAvailability({ platform: 'web', expoGo: false, isDevice: true, projectId: 'p' }), 'web');
  assert.equal(pushAvailability({ platform: 'ios', expoGo: true, isDevice: true, projectId: 'p' }), 'expo-go');
  assert.equal(pushAvailability({ platform: 'android', expoGo: false, isDevice: false, projectId: 'p' }), 'simulator');
  assert.equal(pushAvailability({ platform: 'ios', expoGo: false, isDevice: true, projectId: null }), 'unconfigured');
  assert.equal(pushAvailability({ platform: 'android', expoGo: false, isDevice: true, projectId: 'p' }), 'available');

  const values = new Map<string, string>();
  const store = {
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
  };
  const firstId = await getOrCreateDeviceId(store);
  assert.match(firstId, /^inst-[0-9a-f]{24}$/);
  assert.equal(await getOrCreateDeviceId(store), firstId);

  let permission: 'granted' | 'denied' | 'undetermined' = 'granted';
  const registrations: unknown[] = [];
  const unregistrations: Array<{ deviceId: string; reason: 'signed_out' | 'account_switch' }> = [];
  let releaseToken: ((token: string) => void) | null = null;
  let delayed = false;
  const driver: PushRegistrationDriver = {
    async permission() { return permission; },
    async requestPermission() { return permission === 'granted' ? 'granted' : 'denied'; },
    async getToken() {
      if (!delayed) return 'ExponentPushToken[happy]';
      return new Promise(resolve => { releaseToken = resolve; });
    },
    async register(payload) { registrations.push(payload); },
    async unregister(payload) { unregistrations.push(payload); },
  };
  const epoch = new AccountOperationEpoch();
  epoch.activate('patient-a');
  const happy = await registerForPush({
    accountId: 'patient-a', epoch, availability: 'available', projectId: 'project',
    deviceId: firstId, platform: 'ios', driver,
  });
  assert.equal(happy.status, 'registered');
  assert.equal(registrations.length, 1);

  permission = 'denied';
  const denied = await registerForPush({
    accountId: 'patient-a', epoch, availability: 'available', projectId: 'project',
    deviceId: firstId, platform: 'ios', driver,
  });
  assert.equal(denied.status, 'denied');
  assert.equal(registrations.length, 1);

  permission = 'granted';
  delayed = true;
  const stalePromise = registerForPush({
    accountId: 'patient-a', epoch, availability: 'available', projectId: 'project',
    deviceId: firstId, platform: 'ios', driver,
  });
  await Promise.resolve();
  epoch.activate('patient-b');
  assert(releaseToken);
  releaseToken!('ExponentPushToken[stale]');
  assert.equal((await stalePromise).status, 'stale');
  assert.equal(registrations.length, 1, 'stale account never PUTs its token');

  await unregisterPush(driver, { deviceId: firstId, reason: 'signed_out' });
  assert.deepEqual(unregistrations, [{ deviceId: firstId, reason: 'signed_out' }]);

  assert.equal(resolveNotificationRoute({ route: '/coach-chat' }), '/coach-chat');
  assert.equal(
    resolveNotificationRoute({ route: '/support-chat', kind: 'care_team_reply', thread: 'support' }),
    '/support-chat',
  );
  assert.equal(resolveNotificationRoute({ route: '/(patient)/progress' }), '/(patient)/progress');
  assert.equal(resolveNotificationRoute({ route: 'https://evil.example' }), null);
  assert.equal(resolveNotificationRoute({ route: '/account' }), null);

  assert.deepEqual(parseNotificationPrefs(null), {
    categories: { coachOutreach: true, checkInReminders: true, officeReminders: true },
    quietHours: null,
  });
  const merged = buildNotificationPrefsPatch(
    { notifications: 'enabled', reminderMorning: '8:00 AM', categories: { coachOutreach: false } },
    {
      categories: { coachOutreach: true, checkInReminders: false, officeReminders: true },
      quietHours: { start: '22:00', end: '07:00' },
    },
  );
  assert.equal(merged.reminderMorning, '8:00 AM');
  assert.deepEqual(merged.quietHours, { start: '22:00', end: '07:00' });
  assert.throws(() => buildNotificationPrefsPatch({}, {
    quietHours: { start: '9:00', end: '07:00' },
  }), /HH:MM/);
  assert.throws(() => buildNotificationPrefsPatch({}, {
    quietHours: { start: '08:00', end: '08:00' },
  }), /different/);

  assert.equal(isOutreachMessageId('coach-outreach'), true);
  assert.equal(isOutreachMessageId('coach-outreach:2026-09-24'), true);
  assert.equal(isOutreachMessageId('coach-outreach-other'), false);
  console.log('push availability, registration, routes, preferences, and outreach contracts passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});