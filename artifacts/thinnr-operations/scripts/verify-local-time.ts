/**
 * Device-local clock helpers — the regression behind "it says Sep 15 at 11 PM
 * on Sep 14". Run under several TZ values (see package.json) so the same UTC
 * instant renders as that zone's calendar day, and the salutation follows the
 * local hour.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:local-time
 */
import assert from 'node:assert/strict';
import { formatLocalDate, timeOfDayGreeting } from '../src/lib/local-time';

const tz = process.env.TZ ?? '(unset)';

// 03:19 UTC on Sep 15, 2026 — 11:19 PM Sep 14 in New York, 8:19 PM Sep 14 in LA,
// already Sep 15 in UTC and further east.
const instant = '2026-09-15T03:19:00.000Z';
const localDay = new Date(instant).getDate();
const expected = `Sep ${localDay}, 2026`;
assert.equal(formatLocalDate(instant), expected, `formatLocalDate under TZ=${tz}`);
assert.equal(formatLocalDate(new Date(instant)), expected, 'Date input matches string input');
assert.equal(formatLocalDate('not-a-date'), 'Live', 'unparseable instants degrade to "Live"');

// The old bug: the UTC slice must NOT be what we show when the local day differs.
const utcSlice = instant.split('T')[0];
if (utcSlice !== `2026-09-${String(localDay).padStart(2, '0')}`) {
  assert.notEqual(formatLocalDate(instant), 'Sep 15, 2026', 'must not echo the UTC calendar day');
}

// Salutation boundaries on the local clock.
const at = (hour: number) => new Date(2026, 8, 14, hour, 30);
assert.equal(timeOfDayGreeting(at(4)), 'Good evening');
assert.equal(timeOfDayGreeting(at(5)), 'Good morning');
assert.equal(timeOfDayGreeting(at(11)), 'Good morning');
assert.equal(timeOfDayGreeting(at(12)), 'Good afternoon');
assert.equal(timeOfDayGreeting(at(16)), 'Good afternoon');
assert.equal(timeOfDayGreeting(at(17)), 'Good evening');
assert.equal(timeOfDayGreeting(at(23)), 'Good evening');

console.log(`local-time OK under TZ=${tz}: ${instant} → ${expected}`);
