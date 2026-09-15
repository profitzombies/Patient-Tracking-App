import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AccountOperationEpoch } from '../lib/device-feature-core';
import {
  pushAccountIdFor,
  registerForPush,
  resolveNotificationRoute,
  unregisterPush,
  type PushRegistrationDriver,
} from '../lib/push-notification-core';
import { createPushNotificationsApi } from '../lib/push-notifications-api';
import { MOCK_PATIENTS } from '../data/mock-data';
import {
  DEMO_ATTENTION_ANCHOR_DATE,
  demoAttentionCount,
  demoPatientNeedsAttention,
} from '../lib/staff-attention';

async function main() {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const api = createPushNotificationsApi({
    getToken: async () => 'staff-bearer',
    getBase: () => 'https://api.test/api',
    fetch: fakeFetch as typeof fetch,
  });
  const payload = {
    token: 'ExponentPushToken[staff]',
    deviceId: 'inst-staff-device',
    platform: 'ios' as const,
  };
  await api.registerStaffPushDevice(payload);
  assert.deepEqual(requests[0], {
    method: 'PUT',
    url: 'https://api.test/api/staff-notifications/device',
    body: payload,
  });
  await api.unregisterStaffPushDevice({ deviceId: payload.deviceId, reason: 'signed_out' });
  assert.deepEqual(requests[1], {
    method: 'DELETE',
    url: 'https://api.test/api/staff-notifications/device',
    body: { deviceId: payload.deviceId, reason: 'signed_out' },
  });

  const registrations: unknown[] = [];
  const unregistrations: unknown[] = [];
  let releaseToken: ((token: string) => void) | null = null;
  const driver: PushRegistrationDriver = {
    async permission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getToken() {
      return new Promise<string>(resolve => { releaseToken = resolve; });
    },
    async register(value) { registrations.push(value); },
    async unregister(value) { unregistrations.push(value); },
  };
  const epoch = new AccountOperationEpoch();
  epoch.activate('staff:user-a');
  const stale = registerForPush({
    accountId: 'staff:user-a',
    epoch,
    availability: 'available',
    projectId: 'project',
    deviceId: payload.deviceId,
    platform: 'ios',
    driver,
  });
  await Promise.resolve();
  epoch.activate('staff:user-b');
  assert(releaseToken);
  releaseToken!('ExponentPushToken[stale]');
  assert.equal((await stale).status, 'stale');
  assert.equal(registrations.length, 0, 'a stale staff epoch never registers');

  await unregisterPush(driver, { deviceId: payload.deviceId, reason: 'signed_out' });
  assert.deepEqual(unregistrations, [{ deviceId: payload.deviceId, reason: 'signed_out' }]);

  const staffId = pushAccountIdFor({ mode: 'staff', staffUserId: 'same-id', patientId: 'same-id' });
  const patientId = pushAccountIdFor({ mode: 'patient', staffUserId: 'same-id', patientId: 'same-id' });
  assert.equal(staffId, 'staff:same-id');
  assert.equal(patientId, 'patient:same-id');
  assert.notEqual(staffId, patientId);

  assert.equal(
    resolveNotificationRoute({ kind: 'staff_attention_digest' }),
    '/(tabs)/patients',
  );
  assert.equal(
    resolveNotificationRoute({ kind: 'staff_attention_digest', route: 'https://evil.example' }),
    '/(tabs)/patients',
  );

  const demoCount = demoAttentionCount(MOCK_PATIENTS);
  assert(demoCount > 0);
  assert.equal(demoCount, demoAttentionCount(MOCK_PATIENTS), 'seeded count is stable');
  assert.equal(DEMO_ATTENTION_ANCHOR_DATE, '2026-08-22');
  assert.equal(
    demoPatientNeedsAttention({
      ...MOCK_PATIENTS[1],
      status: 'paused',
      adherence: 0,
      carePlan: { ...MOCK_PATIENTS[1].carePlan, protocolStatus: 'Needs outreach' },
    }),
    false,
    'paused seeded patients never flag',
  );

  for (const path of ['app/persona.tsx', 'app/account.tsx']) {
    const source = await readFile(path, 'utf8');
    const unregisterAt = source.indexOf("unregisterBeforeSignOut(");
    const signOutAt = source.indexOf('auth.signOut()', unregisterAt);
    assert(unregisterAt >= 0 && signOutAt > unregisterAt, `${path} unregisters before sign-out`);
  }

  console.log(`staff push, routing, sign-out, namespaces, and demo attention passed (${demoCount} seeded alerts)`);
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});