import assert from 'node:assert/strict';
import {
  BLOODWORK_MAX_BYTES,
  BloodworkGeneration,
  assertBloodworkByteSize,
  assertImageCapacity,
  assertSuccessfulUploadStatus,
  bloodworkDraftFingerprint,
  canOpenProviderBloodwork,
  makeBloodworkUuid,
  uploadPercent,
} from '../lib/bloodwork-scope';

function throwsMessage(run: () => void, expected: RegExp): void {
  assert.throws(run, error => error instanceof Error && expected.test(error.message));
}

assert.doesNotThrow(() => assertImageCapacity(0, 10), 'ten images are accepted');
throwsMessage(() => assertImageCapacity(10, 1), /at most 10 images/, 'the eleventh image is rejected');
throwsMessage(() => assertImageCapacity(9, 2), /at most 10 images/, 'a multi-picker overflow is rejected whole');

assert.doesNotThrow(() => assertBloodworkByteSize(BLOODWORK_MAX_BYTES, 'PDF'), 'exact PDF boundary is accepted');
throwsMessage(() => assertBloodworkByteSize(BLOODWORK_MAX_BYTES + 1, 'PDF'), /20MB/, 'one byte over is rejected');
throwsMessage(() => assertBloodworkByteSize(0, 'PDF'), /empty/, 'unreadable PDF size is rejected');

assert.equal(uploadPercent(25, 100), 25);
assert.equal(uploadPercent(150, 100), 100);
assert.equal(uploadPercent(10, 0), 0);
assert.doesNotThrow(() => assertSuccessfulUploadStatus(200));
assert.doesNotThrow(() => assertSuccessfulUploadStatus(299));
throwsMessage(() => assertSuccessfulUploadStatus(403), /403/, 'non-2xx PUT is a failure');
throwsMessage(() => assertSuccessfulUploadStatus(undefined), /unknown/, 'missing native response is a failure');

const files = [{ clientFileId: '00000000-0000-4000-8000-000000000001', mimeType: 'image/jpeg', size: 123 }];
const firstFingerprint = bloodworkDraftFingerprint(' CBC ', '', files);
assert.equal(firstFingerprint, bloodworkDraftFingerprint('CBC', '', files), 'unchanged retry keeps the manifest fingerprint');
assert.notEqual(firstFingerprint, bloodworkDraftFingerprint('CBC revised', '', files), 'title edit resets idempotency scope');
assert.notEqual(firstFingerprint, bloodworkDraftFingerprint('CBC', '2026-01-01', files), 'date edit resets idempotency scope');
assert.notEqual(firstFingerprint, bloodworkDraftFingerprint('CBC', '', [...files, { ...files[0], clientFileId: '00000000-0000-4000-8000-000000000002' }]), 'file edit resets idempotency scope');
assert.match(makeBloodworkUuid(() => 0), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

const generations = new BloodworkGeneration();
const stale = generations.begin();
const current = generations.begin();
assert.equal(stale.signal.aborted, true, 'new work aborts stale native/network work');
assert.equal(generations.isCurrent(stale.generation, stale.signal), false);
assert.equal(generations.isCurrent(current.generation, current.signal), true);
generations.cancel();
assert.equal(current.signal.aborted, true, 'account change aborts current work');

const providerBase = {
  sessionUserId: 'staff-user',
  rosterStatus: 'ready' as const,
  rosterPatientIds: ['patient-a'],
  patientId: 'patient-a',
};
assert.equal(canOpenProviderBloodwork(providerBase), true, 'authorized live staff can open roster patient');
assert.equal(canOpenProviderBloodwork({ ...providerBase, sessionUserId: null }), false, 'demo/signed-out role is denied');
assert.equal(canOpenProviderBloodwork({ ...providerBase, rosterStatus: 'unavailable' }), false, 'locked/disabled office is denied');
assert.equal(canOpenProviderBloodwork({ ...providerBase, patientId: 'patient-b' }), false, 'wrong patient is denied');

console.log('bloodwork checks passed: limits, progress, errors, idempotency, generation, and provider role scope');