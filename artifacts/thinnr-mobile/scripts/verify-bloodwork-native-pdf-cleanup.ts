import assert from 'node:assert/strict';
import { disposeBloodworkDraftFiles, pickBloodworkPdf } from '../lib/bloodwork-media';
import { setDocumentAsset } from './bloodwork-native-media-stubs/expo-document-picker';
import { configureNativeFile, deletedUris } from './bloodwork-native-media-stubs/expo-file-system-legacy';

const CACHE_URI = 'file:///app-cache/report.pdf';

async function rejectedCase(
  label: string,
  configure: () => void,
  expected: RegExp,
): Promise<void> {
  configure();
  await assert.rejects(pickBloodworkPdf(), expected, label);
  assert.deepEqual(deletedUris, [CACHE_URI], `${label}: deletes only the picker-created app cache copy`);
}

async function main(): Promise<void> {
  await rejectedCase('unsupported MIME', () => {
    setDocumentAsset({ uri: CACHE_URI, name: 'report.txt', mimeType: 'text/plain' });
    configureNativeFile({});
  }, /not a valid PDF/);

  await rejectedCase('oversize PDF', () => {
    setDocumentAsset({ uri: CACHE_URI, name: 'large.pdf', mimeType: 'application/pdf' });
    configureNativeFile({ size: 20_000_001 });
  }, /20MB limit/);

  await rejectedCase('bad PDF prefix', () => {
    setDocumentAsset({ uri: CACHE_URI, name: 'fake.pdf', mimeType: 'application/pdf' });
    configureNativeFile({ header: 'bm90c' });
  }, /mislabeled/);

  await rejectedCase('getInfo failure', () => {
    setDocumentAsset({ uri: CACHE_URI, name: 'unreadable.pdf', mimeType: 'application/pdf' });
    configureNativeFile({ infoError: new Error('metadata unavailable') });
  }, /metadata unavailable/);

  await rejectedCase('header read failure', () => {
    setDocumentAsset({ uri: CACHE_URI, name: 'unreadable.pdf', mimeType: 'application/pdf' });
    configureNativeFile({ readError: new Error('header unavailable') });
  }, /header unavailable/);

  setDocumentAsset({ uri: CACHE_URI, name: 'valid.pdf', mimeType: 'application/pdf' });
  configureNativeFile({ size: 500, header: 'JVBER' });
  const valid = await pickBloodworkPdf();
  assert(valid, 'valid PDF is handed to the screen');
  assert.deepEqual(deletedUris, [], 'valid handoff retains the app cache copy for its screen owner');
  await disposeBloodworkDraftFiles([valid]);
  assert.deepEqual(deletedUris, [CACHE_URI], 'screen-owner cleanup deletes the retained app cache copy');

  console.log('bloodwork native PDF cleanup checks passed: MIME, size, prefix, read failures, valid handoff ownership');
}

void main();