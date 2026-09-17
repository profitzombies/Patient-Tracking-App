import assert from 'node:assert/strict';
import {
  formatBloodworkElapsedSeconds,
  getBloodworkProcessingLabel,
  getBloodworkProcessingSnapshot,
  type BloodworkReportLike,
} from '../lib/bloodwork-types';
import { formatBloodworkDate, isBloodworkDateKey } from '../lib/bloodwork-date';

const report: BloodworkReportLike = {
  id: 'report-a',
  patientId: 'patient-a',
  title: 'CBC',
  reportDate: '2026-09-10',
  uploadedAt: '2026-09-10T12:00:00.000Z',
  version: 1,
  kind: 'pdf',
  fileCount: 1,
  pageCount: 4,
  extractionStatus: 'processing',
  extractionError: null,
  reviewStatus: 'unreviewed',
  reviewedAt: null,
  processing: {
    phase: 'reading_pages',
    completedPages: 4,
    totalPages: 4,
    startedAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:08.000Z',
    completedAt: null,
    observedAt: '2026-09-10T12:00:08.000Z',
    activity: 'active',
    elapsedSeconds: 8,
    leaseUntil: null,
  },
};

const snapshot = getBloodworkProcessingSnapshot(report);
assert.equal(snapshot.completedPages, 4);
assert.equal(snapshot.totalPages, 4);
assert.equal(snapshot.elapsedSeconds, 8);
assert.equal(snapshot.activity, 'active');
assert.equal(formatBloodworkElapsedSeconds(snapshot.elapsedSeconds), '8s');
assert.equal(getBloodworkProcessingLabel({ ...report, extractionStatus: 'queued', processing: { phase: 'waiting' } }), 'queued');
assert.equal(getBloodworkProcessingLabel({ ...report, extractionStatus: 'processing', processing: { phase: 'reading_pages' } }), 'reading');
assert.equal(getBloodworkProcessingLabel({ ...report, extractionStatus: 'processing', processing: { phase: 'preparing_results' } }), 'organizing');
assert.equal(getBloodworkProcessingLabel({ ...report, extractionStatus: 'completed' }), 'completed');
assert.equal(formatBloodworkDate(report.reportDate), '09/10/26');
assert.equal(isBloodworkDateKey('2026-09-10'), true);
assert.equal(isBloodworkDateKey('2026-02-29'), false);

const invalid = getBloodworkProcessingSnapshot({
  ...report,
  processing: {
    phase: 'reading_pages',
    completedPages: 99,
    totalPages: 4,
    startedAt: null,
    updatedAt: 'not-a-date',
    activity: 'unknown',
    elapsedSeconds: -1,
  },
});
assert.equal(invalid.completedPages, 4, 'server page counts are bounded to total pages');
assert.equal(invalid.updatedAt, null);
assert.equal(invalid.elapsedSeconds, null);
assert.equal(invalid.activity, 'unknown');
const legacyCompleted = getBloodworkProcessingSnapshot({
  ...report,
  processing: null,
  extractionStatus: 'completed',
});
assert.equal(legacyCompleted.totalPages, 4, 'known report page count is retained when progress metadata is absent');
assert.equal(legacyCompleted.completedPages, 4, 'completed status is the only safe completion fallback');

console.log('bloodwork progress/date checks passed: server counts, elapsed, phases, and date-only display');