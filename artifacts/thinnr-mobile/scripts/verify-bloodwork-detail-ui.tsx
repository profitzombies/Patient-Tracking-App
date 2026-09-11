import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import BloodworkDetailScreen from '../app/bloodwork/[id]';
import {
  detailState,
  publishDetail,
  resetDetailState,
  resolveRetry,
  resolveRefetch,
} from './bloodwork-detail-ui-stubs/api-client-react';
import type { BloodworkDetail, BloodworkReport } from '../../../lib/api-client-react/src/generated/api.schemas';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function report(
  extractionStatus: BloodworkReport['extractionStatus'],
  phase: BloodworkReport['processing']['phase'],
  activity: BloodworkReport['processing']['activity'],
  completedPages = 0,
): BloodworkReport {
  return {
    id: 'report-a',
    patientId: 'patient-a',
    title: 'CBC',
    reportDate: '2026-09-10',
    uploadedAt: '2026-09-10T12:00:00Z',
    version: 1,
    kind: 'pdf',
    fileCount: 1,
    pageCount: 4,
    extractionStatus,
    extractionError: extractionStatus === 'failed' ? 'Reader stopped.' : null,
    reviewStatus: 'unreviewed',
    processing: {
      phase,
      completedPages,
      totalPages: 4,
      startedAt: '2026-09-10T12:00:00Z',
      updatedAt: '2026-09-10T12:00:08Z',
      completedAt: extractionStatus === 'completed' ? '2026-09-10T12:00:08Z' : null,
      observedAt: '2026-09-10T12:00:08Z',
      activity,
      elapsedSeconds: 8,
      leaseUntil: null,
    },
  };
}

function detail(reportValue: BloodworkReport): BloodworkDetail {
  return { report: reportValue, files: [], results: [] };
}

function text(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .map(node => node.children.filter(child => typeof child === 'string').join(''))
    .join(' ');
}

async function main(): Promise<void> {
  // First load has a dedicated skeleton. A failed first request has no
  // content to preserve, so it becomes an explicit retry state instead.
  resetDetailState();
  let firstLoad!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    firstLoad = TestRenderer.create(<BloodworkDetailScreen />);
  });
  assert(firstLoad.root.findAllByProps({ testID: 'bloodwork-detail-skeleton' }).length > 0);
  await act(async () => publishDetail(undefined, true));
  assert.equal(firstLoad.root.findAllByProps({ testID: 'bloodwork-detail-skeleton' }).length, 0);
  assert(firstLoad.root.findAllByProps({ testID: 'bloodwork-detail-retry' }).length > 0);
  firstLoad.unmount();

  // A refresh failure keeps the last server response mounted, with an
  // explicit retry/error rail rather than replacing the report with a spinner.
  resetDetailState(detail(report('queued', 'waiting', 'waiting')));
  await act(async () => {
    firstLoad = TestRenderer.create(<BloodworkDetailScreen />);
  });
  await act(async () => publishDetail(detail(report('queued', 'waiting', 'waiting')), true));
  assert.match(text(firstLoad), /CBC/);
  assert(firstLoad.root.findAllByProps({ testID: 'bloodwork-detail-refresh-error' }).length > 0);
  assert(firstLoad.root.findAllByProps({ testID: 'bloodwork-detail-refresh-retry' }).length > 0);
  firstLoad.unmount();

  resetDetailState(detail(report('queued', 'waiting', 'waiting')));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<BloodworkDetailScreen />);
  });
  assert.match(text(renderer), /Waiting to read pages/, 'detail starts in a held queued state');

  await act(async () => publishDetail(detail(report('processing', 'reading_pages', 'active', 2))));
  assert.match(text(renderer), /Reading/);
  await act(async () => publishDetail(detail(report('processing', 'preparing_results', 'active', 4))));
  assert.match(text(renderer), /Preparing results/);
  await act(async () => publishDetail(detail(report('completed', 'completed', 'active', 4))));
  assert.match(text(renderer), /Results ready · Unreviewed/, 'completion is not inferred before the API says completed');

  const edit = renderer.root.findByProps({ testID: 'bloodwork-edit-metadata' });
  assert.equal(edit.props.accessibilityLabel, 'Edit report details');
  await act(async () => edit.props.onPress());
  assert.equal(
    renderer.root.findByProps({ testID: 'bloodwork-edit-metadata-row' }).props.style.flexDirection,
    'column',
    'metadata title/date/save controls stack for phone-width editing',
  );
  assert.equal(renderer.root.findByProps({ accessibilityLabel: 'Save report changes' }).props.accessibilityRole, 'button');
  await act(async () => renderer.root.findByProps({ testID: 'bloodwork-edit-date-clear' }).props.onPress());
  detailState.heldRefetch = true;
  await act(async () => publishDetail(detail(report('processing', 'reading_pages', 'active', 2))));
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Save report changes' }).props.onPress());
  assert.equal(detailState.data?.report.reportDate, null, 'returned report is written to detail cache before edit closes');
  assert.equal(renderer.root.findAllByProps({ testID: 'bloodwork-edit-date-clear' }).length, 0, 'metadata edit closes after cache-first save');
  resolveRefetch();
  await act(async () => await Promise.resolve());
  assert.equal(detailState.data?.report.reportDate, null, 'held stale GET cannot restore the pre-clear date');

  const editAgain = renderer.root.findByProps({ testID: 'bloodwork-edit-metadata' });
  await act(async () => editAgain.props.onPress());
  const draftInputAgain = renderer.root.findByProps({ testID: 'bloodwork-edit-title' });
  await act(async () => draftInputAgain.props.onChangeText('Draft CBC'));
  await act(async () => publishDetail(detail(report('processing', 'reading_pages', 'active', 2)), true));
  assert.equal(renderer.root.findByProps({ testID: 'bloodwork-edit-title' }).props.value, 'Draft CBC', 'failed polling retains the unsaved metadata draft');
  assert.match(text(renderer), /View Source/, 'failed polling retains the saved source action');
  assert.match(text(renderer), /Status could not be refreshed/, 'failed polling is an honest last-known warning');
  const refresh = renderer.root.findByProps({ testID: 'bloodwork-refresh-status' });
  await act(async () => refresh.props.onPress());
  assert.equal(detailState.refetches > 0, true, 'refresh asks only for another status read');
  assert.equal(detailState.retryCalls, 0, 'refresh does not trigger extraction retry');

  await act(async () => publishDetail(detail(report('failed', 'reading_pages', 'active', 2)), false));
  const retry = renderer.root.findByProps({ testID: 'bloodwork-retry-extraction' });
  await act(async () => {
    retry.props.onPress();
    retry.props.onPress();
  });
  assert.equal(detailState.retryCalls, 1, 'duplicate retry taps are locked while the request is held');
  resolveRetry();
  await act(async () => await Promise.resolve());

  renderer.unmount();
  await act(async () => {
    renderer = TestRenderer.create(<BloodworkDetailScreen />);
  });
  await act(async () => publishDetail(detail(report('queued', 'waiting', 'waiting'))));
  assert.match(text(renderer), /Waiting to read pages/, 'remount returns to the server-owned pending state');
  renderer.unmount();
  console.log('bloodwork detail UI checks passed: held query phases, polling retention, refresh/retry locks, and remount');
}

void main();