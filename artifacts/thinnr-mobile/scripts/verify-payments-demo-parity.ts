/**
 * Demo-dataset parity (run: pnpm run test:payments-demo-parity).
 *
 * The provider app's Payments demo persona must render the SAME pinned
 * dataset as the office web payments area. The mobile copy lives in
 * data/office-payments-demo.ts (no cross-artifact import at runtime); this
 * suite imports BOTH copies and deep-compares every export, so a change to
 * the web dataset without re-copying it here fails loudly. Type-only
 * imports are erased, so the web module loads under tsx unchanged.
 */
import * as web from '../../thinnr-operations/src/pages/office/payments/demo-data';
import * as mobile from '../data/office-payments-demo';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const canon = (value: unknown) => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));

const webKeys = Object.keys(web).sort();
const mobileKeys = Object.keys(mobile).sort();
check('same export list', canon(webKeys) === canon(mobileKeys), `web=${webKeys.join(',')} mobile=${mobileKeys.join(',')}`);
for (const key of webKeys) {
  const a = (web as Record<string, unknown>)[key];
  const b = (mobile as Record<string, unknown>)[key];
  if (typeof a === 'function') { check(`${key} is a function on both`, typeof b === 'function'); continue; }
  check(`${key} identical`, canon(a) === canon(b));
}
// The dataset is pinned: nothing in it may depend on the clock.
const before = canon(mobile.DEMO_TODAY);
check('DEMO_TODAY is pinned to the demo day (2026-10-10), not the clock', mobile.DEMO_TODAY.date === '2026-10-10' && mobile.DEMO_TODAY.current_hour === 16);
check('demo series covers the pinned week', mobile.DEMO_DASHBOARD.series[0]?.date === '2026-10-05');

if (failures > 0) { console.error(`\npayments-demo-parity: ${failures} failure(s)`); process.exit(1); }
console.log('\npayments-demo-parity: all checks passed');
