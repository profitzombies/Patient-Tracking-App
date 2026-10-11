/**
 * Staff body measurements (mobile) — card rendering and the Log a Visit
 * sheet.
 *
 *   pnpm --filter @workspace/thinnr-mobile run test:body-measurements
 *
 * REAL BodyMeasurementsCard / LogVisitSheet under react-test-renderer: one
 * column per visit newest first, dashes for unmeasured areas, change since
 * the first visit, two-step inline remove; the sheet blocks an empty visit,
 * keys inch errors to their area, and hands a valid parsed draft to onSave.
 */
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { BODY_AREAS, formatInchesChange, type MeasurementVisit } from '../data/body-measurements';
import { BodyMeasurementsCard, LogVisitSheet, summarizeVisits } from '../components/staff/BodyMeasurementsCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const settle = async (ticks = 6) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props.testID === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => {
  const matches = byTestId(root, id);
  if (matches.length !== 1) throw new Error(`expected exactly one testID="${id}", found ${matches.length}`);
  return matches[0];
};
const press = async (root: ReactTestInstance, id: string) => { await act(async () => { await one(root, id).props.onPress(); }); await settle(2); };
const typeInto = async (root: ReactTestInstance, id: string, text: string) => { await act(async () => { one(root, id).props.onChangeText(text); }); };

async function main() {
  // ─── Card ───────────────────────────────────────────────────────────

  console.log('BodyMeasurementsCard');
  {
    const visits: MeasurementVisit[] = [
      { id: 'a', dateKey: '2026-06-01', note: 'Baseline', measurements: { waist: 36, hips: 41 }, recordedByName: 'Dr. Sarah Jenkins' },
      { id: 'b', dateKey: '2026-08-01', note: null, measurements: { waist: 34.5 } },
    ];
    const events: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<BodyMeasurementsCard visits={visits} onLogPress={() => events.push('log')} onRemove={async (visit) => { events.push(`remove:${visit.id}`); }} />);
    });
    const root = renderer!.root;
    check('columns newest first', root.findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.startsWith('visit-column-')).map((node) => node.props.testID).join(',') === 'visit-column-b,visit-column-a');
    check('ten area rows', root.findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.startsWith('measurement-row-')).length === BODY_AREAS.length);
    check('waist newest: value + −1.5 in', textOf(one(root, 'measurement-cell-waist-b')).includes('34.5') && textOf(one(root, 'measurement-cell-waist-b')).includes(formatInchesChange(-1.5)));
    check('waist baseline labelled', textOf(one(root, 'measurement-cell-waist-a')).includes('First recorded'));
    check('hips unmeasured on newest → dash', textOf(one(root, 'measurement-cell-hips-b')) === '—');
    check('summary reports inches lost', textOf(one(root, 'measurements-summary')).includes('1.5 in lost') && summarizeVisits(visits).includes('2 visits'));
    await press(root, 'log-visit-btn');
    check('Log a Visit fires', events.join(',') === 'log');
    check('remove is two-step: no confirm before tapping', byTestId(root, 'confirm-remove-visit-b').length === 0);
    await press(root, 'remove-visit-b');
    check('first tap reveals Remove/Keep', byTestId(root, 'confirm-remove-visit-b').length === 1 && byTestId(root, 'cancel-remove-visit-b').length === 1);
    await press(root, 'cancel-remove-visit-b');
    check('Keep backs out without removing', byTestId(root, 'confirm-remove-visit-b').length === 0 && !events.includes('remove:b'));
    await press(root, 'remove-visit-b');
    await press(root, 'confirm-remove-visit-b');
    check('confirm removes the visit', events.includes('remove:b'));

    let empty: ReactTestRenderer | undefined;
    await act(async () => { empty = create(<BodyMeasurementsCard visits={[]} onLogPress={() => {}} onRemove={() => {}} />); });
    check('empty state with the button', byTestId(empty!.root, 'measurements-empty').length === 1 && byTestId(empty!.root, 'log-visit-btn').length === 1 && byTestId(empty!.root, 'measurements-table').length === 0);
  }

  // ─── Sheet ──────────────────────────────────────────────────────────

  console.log('LogVisitSheet');
  {
    const TODAY = '2026-09-06';
    const saved: unknown[] = [];
    let closed = 0;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<LogVisitSheet visible todayKey={TODAY} topInset={0} patientName="Maria" onClose={() => { closed += 1; }} onSave={async (draft) => { saved.push(draft); }} />);
    });
    const root = renderer!.root;
    check('one decimal input per area', BODY_AREAS.every((area) => byTestId(root, `visit-input-${area.key}`).length === 1 && one(root, `visit-input-${area.key}`).props.keyboardType === 'decimal-pad'));
    check('date picker defaults to today and caps at today', one(root, 'visit-date').props.accessibilityLabel !== undefined || byTestId(root, `visit-date-day-${TODAY}`).length === 1);
    await press(root, 'visit-save-btn');
    check('empty save blocked with the measurements message', saved.length === 0 && byTestId(root, 'visit-error-measurements').length === 1);
    await typeInto(root, 'visit-input-waist', '34.55');
    await typeInto(root, 'visit-input-neck', '14');
    await press(root, 'visit-save-btn');
    check('two decimals: error keyed to waist only', saved.length === 0 && byTestId(root, 'visit-error-waist').length === 1 && byTestId(root, 'visit-error-neck').length === 0 && byTestId(root, 'visit-error-measurements').length === 0);
    await typeInto(root, 'visit-input-waist', '34.5');
    check('typing clears the inline error', byTestId(root, 'visit-error-waist').length === 0);
    await typeInto(root, 'visit-note', '  Over light clothing ');
    await press(root, 'visit-save-btn');
    check('valid save hands the parsed draft over', JSON.stringify(saved[0]) === JSON.stringify({ dateKey: TODAY, note: 'Over light clothing', measurements: { neck: 14, waist: 34.5 } }), JSON.stringify(saved[0]));
    check('saved state shown, save disabled', byTestId(root, 'visit-saved').length === 1 && one(root, 'visit-save-btn').props.disabled === true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    check('sheet closes itself after saving', closed >= 1);

    let failing: ReactTestRenderer | undefined;
    await act(async () => { failing = create(<LogVisitSheet visible todayKey={TODAY} topInset={0} patientName="Maria" onClose={() => {}} onSave={async () => { throw new Error('Storage is full.'); }} />); });
    await typeInto(failing!.root, 'visit-input-hips', '40');
    await press(failing!.root, 'visit-save-btn');
    check('a failed save surfaces the error and stays open', textOf(one(failing!.root, 'visit-error-measurements')).includes('Storage is full.') && byTestId(failing!.root, 'visit-saved').length === 0);

    let hidden: ReactTestRenderer | undefined;
    await act(async () => { hidden = create(<LogVisitSheet visible={false} todayKey={TODAY} topInset={0} patientName="Maria" onClose={() => {}} onSave={async () => {}} />); });
    check('hidden sheet renders nothing', byTestId(hidden!.root, 'visit-save-btn').length === 0);
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll mobile body-measurement checks passed.');
}

main().catch((error) => { console.error(error); process.exit(1); });
