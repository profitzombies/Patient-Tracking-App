import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  CoachOutreachTimeline,
  NotificationTimelineContent,
  OutreachChip,
  outreachChipModel,
} from '../src/components/office/NotificationTimeline';
import {
  fetchOfficePatientNotifications,
  type NotificationDeliveryStatus,
  type OfficePatientNotification,
  type OfficePatientNotifications,
  type OutreachRoster,
  type OutreachRosterState,
} from '../src/lib/office-roster';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') parts.push(node);
    else node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}

const outreach = (
  state: OutreachRosterState,
  delivery: NotificationDeliveryStatus | null = null,
  deliveryDetail: string | null = null,
): OutreachRoster => ({
  state,
  eligible: state !== 'none',
  crossedOnKey: state === 'none' ? null : '2026-09-01',
  evaluatedAt: '2026-09-01T12:00:00Z',
  lastSentKey: delivery ? '2026-09-01' : null,
  delivery,
  deliveryDetail,
  notificationId: delivery ? 'notification-1' : null,
});

const baseNotification = (
  id: string,
  status: NotificationDeliveryStatus,
  overrides: Partial<OfficePatientNotification> = {},
): OfficePatientNotification => ({
  id,
  kind: 'stall_nudge',
  category: 'coach_outreach',
  title: `Notification ${id}`,
  body: 'A body not shown in the compact staff timeline.',
  status,
  suppressionReason: null,
  lastError: null,
  attempts: 1,
  scheduledAt: '2026-09-01T12:00:00Z',
  expiresAt: '2026-09-02T12:00:00Z',
  createdAt: '2026-09-01T12:00:00Z',
  sentAt: null,
  deliveredAt: null,
  openedAt: null,
  engagedAt: null,
  finalizedAt: null,
  nextAttemptAt: null,
  events: [{ at: '2026-09-01T12:00:00Z', kind: 'queued', detail: null }],
  ...overrides,
});

const PAYLOAD: OfficePatientNotifications = {
  patientId: 'pat-1',
  outreach: outreach('sent_awaiting', 'failed', 'Push provider rejected the device token'),
  notifications: [
    baseNotification('queued', 'queued', {
      category: 'check_in_reminders',
      nextAttemptAt: '2026-09-01T12:30:00Z',
      events: [
        { at: '2026-09-01T12:10:00Z', kind: 'attempt_failed', detail: 'Temporary network error' },
        { at: '2026-09-01T12:00:00Z', kind: 'queued', detail: null },
      ],
    }),
    baseNotification('failed', 'failed', {
      lastError: 'Push provider rejected the device token',
      events: [
        { at: '2026-09-01T13:10:00Z', kind: 'failed', detail: 'Push provider rejected the device token' },
        { at: '2026-09-01T13:00:00Z', kind: 'queued', detail: null },
      ],
    }),
    baseNotification('suppressed', 'suppressed', {
      category: 'office_reminders',
      suppressionReason: 'no_device',
      events: [
        { at: '2026-09-01T14:05:00Z', kind: 'suppressed', detail: 'No registered device' },
        { at: '2026-09-01T14:00:00Z', kind: 'queued', detail: null },
      ],
    }),
  ],
};

const stamp = (date: string) => date.slice(11, 16);

console.log('outreach chip mapping');
{
  const cases: Array<[OutreachRoster, string | null]> = [
    [outreach('none'), null],
    [outreach('eligible'), 'Outreach due'],
    [outreach('sent_awaiting', 'delivered'), 'Outreach sent · awaiting reply'],
    [outreach('engaged', 'opened'), 'Replied to outreach'],
    [outreach('opted_out', 'opted_out'), 'Nudges paused'],
    [outreach('sent_awaiting', 'failed', 'Token rejected'), 'Outreach not delivered'],
    [outreach('sent_awaiting', 'suppressed', 'No registered device'), 'Outreach suppressed'],
    [outreach('sent_awaiting', 'expired'), 'Outreach expired'],
  ];
  cases.forEach(([value, expected]) => {
    const model = outreachChipModel(value);
    check(`${value.state}/${value.delivery ?? 'none'} maps to ${expected ?? 'no chip'}`, model?.label === expected || (!model && expected === null));
  });
  let renderer: ReactTestRenderer | undefined;
  act(() => { renderer = create(<OutreachChip outreach={outreach('sent_awaiting', 'failed', 'Token rejected')} />); });
  const chip = renderer!.root.findByProps({ 'data-testid': 'status-outreach' });
  check('delivery detail is exposed as the chip tooltip', chip.props.title === 'Token rejected');
  check('chip is non-interactive status text', chip.type === 'span' && chip.findAll((node) => node.type === 'button' || node.type === 'a').length === 0);
  renderer!.unmount();
}

console.log('\nnotification timeline rendering');
{
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<CoachOutreachTimeline payload={PAYLOAD} isLoading={false} error={null} formatTimestamp={stamp} />);
  });
  const root = renderer!.root;
  const text = textOf(root);
  check('timeline renders title, categories, and status pills', ['Notification queued', 'Check-in reminder', 'failed', 'suppressed', 'Office reminder'].every((token) => text.includes(token)), text);
  check('queued notification shows its next attempt', text.includes('Next attempt 12:30'), text);
  check('failed and suppressed details remain visible', text.includes('Push provider rejected the device token') && text.includes('No registered device'), text);
  const queued = root.findByProps({ 'data-testid': 'notification-queued' });
  const eventText = textOf(queued);
  check('events render oldest to newest', eventText.indexOf('12:00') < eventText.indexOf('12:10'), eventText);
  check('attempt failure detail is rendered', eventText.includes('Temporary network error'), eventText);
  check('timeline cards add no unnamed interactive controls', root.findAll((node) => node.type === 'button' || node.type === 'a').length === 0);
  renderer!.unmount();
}

console.log('\nloading, empty, and error states');
{
  let renderer: ReactTestRenderer | undefined;
  act(() => { renderer = create(<NotificationTimelineContent isLoading payload={undefined} error={null} formatTimestamp={stamp} />); });
  check('loading is announced and never looks empty', renderer!.root.findAllByProps({ role: 'status' }).length === 1 && !textOf(renderer!.root).includes('No notifications yet'));
  renderer!.unmount();

  const emptyPayload = { ...PAYLOAD, outreach: outreach('eligible'), notifications: [] };
  act(() => { renderer = create(<NotificationTimelineContent isLoading={false} payload={emptyPayload} error={null} formatTimestamp={stamp} />); });
  check('successful empty response says no notifications yet', textOf(renderer!.root).includes('No notifications yet'));
  renderer!.unmount();

  act(() => { renderer = create(<NotificationTimelineContent isLoading={false} payload={undefined} error={new Error('Timeline service unavailable')} formatTimestamp={stamp} />); });
  check('failure is an honest alert, never an empty success', renderer!.root.findAllByProps({ role: 'alert' }).length === 1 && textOf(renderer!.root).includes('Timeline service unavailable') && !textOf(renderer!.root).includes('No notifications yet'));
  renderer!.unmount();

  const none = { ...PAYLOAD, outreach: outreach('none'), notifications: [] };
  act(() => { renderer = create(<CoachOutreachTimeline isLoading={false} payload={none} error={null} formatTimestamp={stamp} />); });
  check('inactive empty timeline card is omitted after success', renderer!.toJSON() === null);
  renderer!.unmount();
}

console.log('\nnotification client URL');
{
  __setSupabaseSession('staff-token');
  const urls: string[] = [];
  const g = globalThis as unknown as { fetch: typeof fetch };
  g.fetch = async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ ...PAYLOAD, notifications: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await fetchOfficePatientNotifications('pat/with space');
  await fetchOfficePatientNotifications('pat/with space', 'office/a & b');
  check('patient id is encoded and provider scope omits office', urls[0] === '/api/office/patients/pat%2Fwith%20space/notifications', urls[0]);
  check('HQ office parameter is encoded', urls[1] === '/api/office/patients/pat%2Fwith%20space/notifications?office=office%2Fa%20%26%20b', urls[1]);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall notification-timeline checks passed');