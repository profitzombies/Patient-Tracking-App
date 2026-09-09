import assert from 'node:assert/strict';
import { uploadFileWithProgress } from '../lib/bloodwork-upload';
import {
  cancelCalls,
  configureUpload,
  lastOptions,
} from 'expo-file-system/legacy';

async function main(): Promise<void> {
  configureUpload({ status: 201 });
  const progress: number[] = [];
  await uploadFileWithProgress(
    'https://upload.invalid/put',
    'file:///report.jpg',
    'image/jpeg',
    value => progress.push(value),
  );
  assert.deepEqual(progress, [25], 'native callback reports real sent/expected bytes');
  assert.equal(lastOptions?.headers?.['Content-Type'], 'image/jpeg', 'native PUT pins content type');

  configureUpload({ status: 503 });
  await assert.rejects(
    uploadFileWithProgress('https://upload.invalid/put', 'file:///report.pdf', 'application/pdf', () => {}),
    /503/,
    'native non-2xx PUT is rejected',
  );

  configureUpload({ status: 200, holdUntilCancel: true });
  const controller = new AbortController();
  const pending = uploadFileWithProgress(
    'https://upload.invalid/put',
    'file:///report.pdf',
    'application/pdf',
    () => {},
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(cancelCalls, 1, 'account cancellation reaches the native upload task');

  console.log('bloodwork native upload adapter checks passed: bytes, status, content type, cancellation');
}

void main();