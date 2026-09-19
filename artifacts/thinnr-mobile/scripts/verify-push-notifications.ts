import assert from 'node:assert/strict';
import { AccountOperationEpoch } from '../lib/device-feature-core';
import {
  buildNotificationPrefsPatch,
  getOrCreateDeviceId,
  parseNotificationPrefs,
  pushAvailability,
  registerForPush,
  resolveNotificationRoute,
  notificationAdmittedForPatient,
  notificationPatientId,
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
  assert.equal(resolveNotificationRoute({ route: '/orders' }), '/orders');
  assert.equal(resolveNotificationRoute({ route: '/my-subscriptions' }), '/my-subscriptions');
  // Billing notices resolve by kind + uuid, never by the route string alone.
  const shippedTap = { kind: 'order_shipped', patientId: 'patient-a', orderId: '22222222-2222-4222-8222-222222222222', route: '/orders/22222222-2222-4222-8222-222222222222' };
  assert.equal(resolveNotificationRoute(shippedTap), '/orders/22222222-2222-4222-8222-222222222222');
  assert.equal(resolveNotificationRoute({ ...shippedTap, orderId: '../admin' }), null);
  assert.equal(resolveNotificationRoute({ ...shippedTap, patientId: undefined }), null);
  const renewalTap = { kind: 'subscription_renewal_upcoming', patientId: 'patient-a', subscriptionId: '33333333-3333-4333-8333-333333333333' };
  assert.equal(resolveNotificationRoute(renewalTap), '/my-subscriptions/33333333-3333-4333-8333-333333333333');
  assert.equal(resolveNotificationRoute({ ...renewalTap, kind: 'subscription_payment_failed' }), '/my-subscriptions/33333333-3333-4333-8333-333333333333');
  assert.equal(resolveNotificationRoute({ ...renewalTap, kind: 'something_else' }), null);
  assert.equal(notificationAdmittedForPatient(shippedTap, 'patient-a'), true);
  assert.equal(notificationAdmittedForPatient(shippedTap, 'patient-b'), false);
  assert.equal(notificationAdmittedForPatient(renewalTap, null), false);
  // Generic (PHI-free) server payloads: the lock screen says nothing specific, so the deep link
  // alone must land the patient on the right screen. These mirror the server builders exactly.
  const genericPayloads: Array<[string, Record<string, unknown>, string]> = [
    ['missed dose', { route: '/check-in', medicationId: '44444444-4444-4444-8444-444444444444', dueDate: '2026-07-01', dueTime: '09:00', kind: 'missed_dose', category: 'check_in_reminders', notificationId: 'n-1' }, '/check-in'],
    ['coach outreach', { route: '/coach-chat', crossingKey: '2026-07-01', messageClientId: 'outreach:2026-07-01', kind: 'coach_outreach', category: 'coach_outreach', notificationId: 'n-2' }, '/coach-chat'],
    ['order shipped', { route: '/orders/22222222-2222-4222-8222-222222222222', kind: 'order_shipped', orderId: '22222222-2222-4222-8222-222222222222', patientId: 'patient-a', notificationId: 'n-3', category: 'account' }, '/orders/22222222-2222-4222-8222-222222222222'],
    ['renewal upcoming', { route: '/my-subscriptions/33333333-3333-4333-8333-333333333333', kind: 'subscription_renewal_upcoming', subscriptionId: '33333333-3333-4333-8333-333333333333', patientId: 'patient-a', shipDate: '2026-09-20' }, '/my-subscriptions/33333333-3333-4333-8333-333333333333'],
    ['payment failed', { route: '/my-subscriptions/33333333-3333-4333-8333-333333333333', kind: 'subscription_payment_failed', subscriptionId: '33333333-3333-4333-8333-333333333333', patientId: 'patient-a', invoiceId: 'in_1' }, '/my-subscriptions/33333333-3333-4333-8333-333333333333'],
    ['care-team suggestion', { patientId: 'patient-a', thread: 'care_team', conversationId: '11111111-1111-4111-8111-111111111111', kind: 'care_team_reply', category: 'office_reminders', suggestion: true, notificationId: 'n-4' }, '/care-team-chat?conversationId=11111111-1111-4111-8111-111111111111'],
    ['staff digest', { route: '/(tabs)/patients', kind: 'staff_attention_digest', category: 'staff_alerts', notificationId: 'n-5', providerId: 'office-1', digestDate: '2026-10-10', flaggedCount: 2 }, '/(tabs)/patients'],
  ];
  for (const [label, payload, expected] of genericPayloads) {
    assert.equal(resolveNotificationRoute(payload), expected, `${label} deep link`);
    for (const key of Object.keys(payload)) {
      assert.doesNotMatch(key, /name|weight|medication$|reason|patients|product|carrier|tracking|message$|text|body|title/i, `${label} payload carries ${key}`);
    }
  }
  const careTeamTap = {
    kind: 'care_team_reply',
    thread: 'care_team',
    patientId: 'patient-a',
    conversationId: '11111111-1111-4111-8111-111111111111',
  };
  assert.equal(
    resolveNotificationRoute(careTeamTap),
    '/care-team-chat?conversationId=11111111-1111-4111-8111-111111111111',
  );
  assert.equal(notificationPatientId(careTeamTap), 'patient-a');
  assert.equal(notificationAdmittedForPatient(careTeamTap, 'patient-a'), true);
  assert.equal(
    notificationAdmittedForPatient(careTeamTap, 'patient-b'),
    false,
    'an old-account care-team tap is not delivered to the newly selected patient',
  );
  assert.equal(
    notificationAdmittedForPatient({ ...careTeamTap, patientId: undefined }, 'patient-a'),
    false,
    'care-team notification ownership fails closed',
  );
  assert.equal(
    notificationAdmittedForPatient({ kind: 'care_team_reply', thread: 'coach' }, 'patient-b'),
    true,
    'historic coach/support notification grounding and routing remain unchanged',
  );

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