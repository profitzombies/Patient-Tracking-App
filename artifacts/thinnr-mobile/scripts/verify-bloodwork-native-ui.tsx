import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { BloodworkDateField } from '../components/bloodwork/BloodworkDateField';
import { BloodworkProcessingStatus } from '../components/bloodwork/BloodworkProcessingStatus';
import { BloodworkViewer } from '../components/bloodwork/BloodworkViewer';
import type { BloodworkReportLike } from '../lib/bloodwork-types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
process.env.EXPO_PUBLIC_DOMAIN = 'private-api.example.test';

function report(
  extractionStatus: BloodworkReportLike['extractionStatus'],
  phase: NonNullable<NonNullable<BloodworkReportLike['processing']>>['phase'],
  activity: NonNullable<NonNullable<BloodworkReportLike['processing']>>['activity'],
  completedPages = 0,
): BloodworkReportLike {
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

function text(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .map(node => node.children.filter(child => typeof child === 'string').join(''))
    .join(' ');
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findByProps({ testID });
}

async function mount(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function main(): Promise<void> {
  let status = await mount(
    <BloodworkProcessingStatus report={report('queued', 'waiting', 'waiting')} onRefresh={() => {}} />,
  );
  assert.match(text(status), /Waiting to read pages/);
  assert.match(text(status), /0 of 4 pages read/);
  assert.match(text(status), /safely leave this screen/);
  assert.equal(status.root.findAllByType('ActivityIndicator').length, 0, 'waiting uses a clock, not active spinner');
   assert.deepEqual(byTestId(status, 'bloodwork-processing-progress').props.accessibilityValue, { min: 0, max: 4, now: 0 });

  await act(async () => {
    status.update(<BloodworkProcessingStatus report={report('processing', 'reading_pages', 'active', 2)} onRefresh={() => {}} />);
  });
   assert.match(text(status), /Reading/);
  assert.equal(status.root.findAllByType('ActivityIndicator').length, 1);
  assert.equal(byTestId(status, 'bloodwork-processing-progress').props.accessibilityValue.now, 2);

  await act(async () => {
    status.update(<BloodworkProcessingStatus report={report('processing', 'preparing_results', 'active', 4)} onRefresh={() => {}} />);
  });
  assert.match(text(status), /Preparing results/);
   assert.deepEqual(byTestId(status, 'bloodwork-processing-progress').props.accessibilityValue, { min: 0, max: 4, now: 4 }, 'progress uses only reported source pages');

  let refreshCalls = 0;
  await act(async () => {
    status.update(
      <BloodworkProcessingStatus
        report={report('processing', 'reading_pages', 'delayed', 2)}
        pollingError
        onRefresh={() => { refreshCalls += 1; }}
      />,
    );
  });
  assert.equal(status.root.findAllByType('ActivityIndicator').length, 0, 'delayed polling does not imply active progress');
  assert.match(text(status), /Status could not be refreshed/);
  assert.match(text(status), /last server update/);
  await act(async () => byTestId(status, 'bloodwork-refresh-status').props.onPress());
  assert.equal(refreshCalls, 1, 'refresh only asks for status');

  await act(async () => {
    status.update(<BloodworkProcessingStatus report={report('completed', 'completed', 'active', 4)} />);
  });
  assert.match(text(status), /Results ready · Unreviewed/);
   assert.deepEqual(byTestId(status, 'bloodwork-processing-progress').props.accessibilityValue, { min: 0, max: 4, now: 4 });

  let selectedDate = '';
  const date = await mount(<BloodworkDateField testID="date" value="" onChange={value => { selectedDate = value; }} />);
  await act(async () => byTestId(date, 'date-toggle').props.onPress());
  const calendar = byTestId(date, 'date-calendar');
  assert(date.root.findAllByProps({ accessibilityLabel: 'Calendar date picker' }).length > 0);
  await act(async () => calendar.findAllByProps({ testID: 'date-calendar-day-2026-09-10' })[0].props.onPress());
  assert.equal(selectedDate, '2026-09-10', 'picker emits date-only key');
  await act(async () => date.update(<BloodworkDateField testID="date" value={selectedDate} onChange={value => { selectedDate = value; }} />));
  await act(async () => byTestId(date, 'date-clear').props.onPress());
  assert.equal(selectedDate, '', 'clear returns nullable empty date');
  await act(async () => date.update(<BloodworkDateField testID="date" value="2026-09-10" disabled onChange={() => { throw new Error('disabled date changed'); }} />));
  assert.equal(date.root.findAllByProps({ testID: 'date-calendar' }).length, 0, 'disabled date hides an already-open calendar');
  assert.deepEqual(
    byTestId(date, 'date-toggle').props.accessibilityState,
    { disabled: true, expanded: false },
    'disabled date exposes disabled/collapsed state to assistive technology',
  );
  assert.equal(byTestId(date, 'date-toggle').props['aria-disabled'], true);
  assert.equal(byTestId(date, 'date-toggle').props['aria-expanded'], false);

  let closed = 0;
  const viewer = await mount(
    <BloodworkViewer
      visible
      onClose={() => { closed += 1; }}
      reportDetail={{
        report: report('completed', 'completed', 'active', 4),
        files: [{ id: 'file-a', position: 0, mimeType: 'application/pdf', size: 10, pageCount: 2, width: null, height: null }],
        results: [],
      }}
      token="token-a"
      patientId="patient-a"
    />,
  );
  const close = byTestId(viewer, 'bloodwork-viewer-close');
  assert.equal(close.props.style.width, 44);
  assert(viewer.root.findAllByProps({ testID: 'bloodwork-source-skeleton' }).length > 0, 'source pages show a placeholder while the image is loading');
  const imageBeforeRetry = viewer.root.findAllByType('ZoomableImage')[0];
  assert(imageBeforeRetry, 'mounted source image keeps native load callbacks');
  const staleError = imageBeforeRetry.props.onError as () => void;
  await act(async () => staleError());
  const sourceRetryBeforeStaleEvent = byTestId(viewer, 'bloodwork-source-retry');
  await act(async () => sourceRetryBeforeStaleEvent.props.onPress());
  await act(async () => staleError());
  assert.equal(viewer.root.findAllByProps({ testID: 'bloodwork-source-retry' }).length, 0, 'a late same-page image error cannot poison the retried page');
  const imageAfterRetry = viewer.root.findAllByType('ZoomableImage')[0];
  await act(async () => imageAfterRetry.props.onLoad());
  assert.equal(viewer.root.findAllByProps({ testID: 'bloodwork-source-skeleton' }).length, 0, 'loaded source page leaves its skeleton');
  await act(async () => viewer.update(
    <BloodworkViewer
      visible
      onClose={() => { closed += 1; }}
      reportDetail={{
        report: { ...report('completed', 'completed', 'active', 4), title: 'CBC refreshed' },
        files: [{ id: 'file-a', position: 0, mimeType: 'application/pdf', size: 10, pageCount: 2, width: null, height: null }],
        results: [],
      }}
      token="token-a"
      patientId="patient-a"
    />,
  ));
  assert.equal(viewer.root.findAllByProps({ testID: 'bloodwork-source-skeleton' }).length, 0, 'same source page stays loaded across a detail refresh');
  const top = viewer.root.findAllByType('View').find(node => {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    return styles.some(style => style?.paddingTop === 18);
  });
  assert(top, 'native viewer header is inset below status area');
  await act(async () => close.props.onPress());
  assert.equal(closed, 1, 'viewer closes without changing report context');
  viewer.unmount();

  // The web source request has its own retryable error state. A failed page
  // request must not leave a spinner that implies work is still progressing.
  Platform.OS = 'web';
  const originalFetch = globalThis.fetch;
  let sourceFetches = 0;
  globalThis.fetch = (async () => {
    sourceFetches += 1;
    return new Response(null, { status: 503 });
  }) as typeof globalThis.fetch;
  const failedSource = await mount(
    <BloodworkViewer
      visible
      onClose={() => {}}
      reportDetail={{
        report: report('completed', 'completed', 'active', 4),
        files: [{ id: 'file-a', position: 0, mimeType: 'application/pdf', size: 10, pageCount: 1, width: null, height: null }],
        results: [],
      }}
      token="token-a"
      patientId="patient-a"
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(text(failedSource), /could not be loaded/i);
  const sourceRetry = byTestId(failedSource, 'bloodwork-source-retry');
  await act(async () => sourceRetry.props.onPress());
  assert.equal(sourceFetches, 2, 'source page retry starts a fresh request');
  failedSource.unmount();
  globalThis.fetch = originalFetch;
  Platform.OS = 'ios';
  date.unmount();
  status.unmount();
  console.log('bloodwork native UI checks passed: phases, held polling, dates, progressbar, and safe-area viewer');
}

void main();