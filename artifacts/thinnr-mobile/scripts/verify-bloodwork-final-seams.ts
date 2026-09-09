import assert from 'node:assert/strict';
import { getGetBloodworkFilePageUrl, type BloodworkReport } from '@workspace/api-client-react';
import { resolveBloodworkSourceUrl } from '../lib/bloodwork-url';
import {
  BLOODWORK_TRANSCRIPTION_DISCLOSURE,
  BloodworkCaptureGuard,
  buildBloodworkMetadataUpdate,
  clearDeletedStageRequest,
  emptyBloodworkDraftMetadata,
  isCommittedUploadReplay,
} from '../lib/bloodwork-scope';
import {
  assertBrowserPdf,
  disposeBloodworkDraftFiles,
  pickBloodworkPdf,
  prepareBloodworkImage,
  prepareBloodworkImageBatch,
  type BloodworkDraftFile,
} from '../lib/bloodwork-media';
import { loadBloodworkHistoryPages } from '../lib/use-bloodwork-history';
import { setDocumentAsset } from './bloodwork-browser-stubs/expo-document-picker';
import { setManipulatedResult } from './bloodwork-browser-stubs/expo-image-manipulator';

process.env.EXPO_PUBLIC_DOMAIN = 'private-api.example.test';

function report(id: string): BloodworkReport {
  return {
    id,
    patientId: 'patient-a',
    title: id,
    reportDate: null,
    uploadedAt: '2026-01-01T00:00:00Z',
    version: 1,
    kind: 'images',
    fileCount: 1,
    pageCount: 1,
    extractionStatus: 'completed',
    extractionError: null,
    reviewStatus: 'unreviewed',
  };
}

async function main(): Promise<void> {
  const generated = getGetBloodworkFilePageUrl('patient-a', 'report-a', 'file-a', 1);
  const nativeUrl = resolveBloodworkSourceUrl(generated);
  assert.equal(nativeUrl, 'https://private-api.example.test/api/bloodwork/patients/patient-a/reports/report-a/files/file-a/pages/1');
  assert.throws(() => resolveBloodworkSourceUrl('https://attacker.invalid/page'), /untrusted origin/);

  const pdf = new File([new TextEncoder().encode('%PDF-real-browser-data')], 'labs.pdf', { type: 'application/pdf' });
  setDocumentAsset({ uri: 'blob:picker-owned', name: pdf.name, mimeType: pdf.type, file: pdf });
  const picked = await pickBloodworkPdf();
  assert.equal(picked?.size, pdf.size, 'browser PDF size comes from File, without expo-file-system');
  assert.equal(picked?.appOwned, true);
  await assert.rejects(assertBrowserPdf(new Blob(['not-pdf'])), /mislabeled/);

  const imageBlobUrl = URL.createObjectURL(new Blob(['real-image-bytes'], { type: 'image/jpeg' }));
  setManipulatedResult({ uri: imageBlobUrl, width: 100, height: 100 });
  const image = await prepareBloodworkImage({ uri: 'blob:picker-image', width: 100, height: 100, type: 'image' });
  assert.equal(image.size, 16, 'browser image size comes from Blob, without expo-file-system');
  await disposeBloodworkDraftFiles([image, ...(picked ? [picked] : [])]);
  URL.revokeObjectURL(imageBlobUrl);

  const request = { fingerprint: 'same-draft', id: 'request-a' };
  assert.equal(clearDeletedStageRequest(request, 'request-a'), null, 'deleted cancelled stage rotates request id');
  assert.deepEqual(clearDeletedStageRequest(request, 'other-request'), request);
  assert.equal(isCommittedUploadReplay(0, 1), true, 'committed create replay skips missing PUT URLs and commit');
  assert.equal(isCommittedUploadReplay(1, 1), false);

  assert.deepEqual(
    buildBloodworkMetadataUpdate({
      version: 7,
      originalTitle: 'CBC',
      originalReportDate: '2026-01-01',
      titleDraft: 'CBC',
      dateDraft: '2026-02-02',
    }),
    { expectedVersion: 7, title: 'CBC', reportDate: '2026-02-02' },
    'date-only metadata edit retains the edit-start version',
  );

  const capture = new BloodworkCaptureGuard();
  capture.setVisible(true);
  const captureEpoch = capture.begin();
  capture.setVisible(false);
  assert.equal(capture.accepts(captureEpoch), false, 'late native camera result is rejected after close');
  assert.deepEqual(emptyBloodworkDraftMetadata(), { title: '', reportDate: '' }, 'account switch clears identifying draft metadata');

  const revoked: string[] = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = url => revoked.push(String(url));
  const partial: BloodworkDraftFile = {
    clientFileId: 'partial',
    uri: 'blob:partial-prepared',
    mimeType: 'image/jpeg',
    size: 5,
    appOwned: true,
  };
  let calls = 0;
  await assert.rejects(
    prepareBloodworkImageBatch(
      [
        { uri: 'first', width: 1, height: 1, type: 'image' },
        { uri: 'second', width: 1, height: 1, type: 'image' },
      ],
      () => true,
      async () => {
        calls += 1;
        if (calls === 2) throw new Error('second preparation failed');
        return partial;
      },
    ),
    /second preparation failed/,
  );
  URL.revokeObjectURL = originalRevoke;
  assert.deepEqual(revoked, ['blob:partial-prepared'], 'partial prepared batch is disposed on failure');

  const requestedCursors: Array<string | undefined> = [];
  const paged = await loadBloodworkHistoryPages({
    patientId: 'patient-a',
    token: 'token-a',
    pageCount: 2,
    fetchPage: async (_patientId, params) => {
      requestedCursors.push(params?.cursor);
      return params?.cursor
        ? { reports: [report('21')], nextCursor: 'cursor-3' }
        : { reports: Array.from({ length: 20 }, (_, i) => report(String(i + 1))), nextCursor: 'cursor-2' };
    },
  });
  assert.equal(paged.reports.length, 21);
  assert.equal(paged.nextCursor, 'cursor-3');
  assert.deepEqual(requestedCursors, [undefined, 'cursor-2'], 'retained history reload traverses every loaded page');

  assert.match(BLOODWORK_TRANSCRIPTION_DISCLOSURE, /automatic AI transcription/);
  assert.match(BLOODWORK_TRANSCRIPTION_DISCLOSURE, /consent/);
  console.log('bloodwork final seam checks passed: native URL, browser files, retry, metadata, cleanup, pagination, disclosure');
}

void main();