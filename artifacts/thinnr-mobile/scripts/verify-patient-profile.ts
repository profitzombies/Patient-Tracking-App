import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ANSWERS,
  isValidDateKey,
  localStartDateKeyFor,
  visibleSteps,
} from '../data/onboarding-data';
import { parsePatientProfile } from '../lib/patient-profile';

const leapEve = new Date(2028, 1, 28, 23, 30);
assert.equal(localStartDateKeyFor(0, leapEve), '2028-02-28');
assert.equal(localStartDateKeyFor(1, leapEve), '2028-02-29');
assert.equal(localStartDateKeyFor(2, leapEve), '2028-03-01');
assert.equal(isValidDateKey('2028-02-29'), true);
assert.equal(isValidDateKey('2027-02-29'), false);

const demo = visibleSteps(DEFAULT_ANSWERS, false);
const real = visibleSteps(DEFAULT_ANSWERS, true);
assert.equal(demo.includes('identity'), false, 'demo must retain its simulated account flow');
assert.equal(demo.includes('contact'), true);
assert.equal(real.includes('identity'), true, 'real setup must collect canonical identity');
assert.equal(real.includes('contact'), false, 'real setup must not use mock verification');
const startedReal = visibleSteps(
  { ...DEFAULT_ANSWERS, program: 'thinnr', started: 'yes' },
  true,
);
const startedDemo = visibleSteps(
  { ...DEFAULT_ANSWERS, program: 'thinnr', started: 'yes' },
  false,
);
assert.equal(startedReal.includes('start-date'), true, 'real setup must confirm an actual historical start date');
assert.equal(startedDemo.includes('start-date'), false, 'demo must retain its original seeded start behavior');

const apiSource = fs.readFileSync(
  path.resolve(__dirname, '../lib/patient-data-api.ts'),
  'utf8',
);
for (const endpoint of [
  '/patient-data/profile',
  '/patient-data/setup',
  '/patient-data/profile/setup',
  '/patient-data/profile/contact/start',
  '/patient-data/profile/contact/verify',
]) {
  assert.equal(apiSource.includes(endpoint), true, `missing canonical API call: ${endpoint}`);
}

const contextSource = fs.readFileSync(
  path.resolve(__dirname, '../context/OnboardingContext.tsx'),
  'utf8',
);
assert.match(contextSource, /await advance\(next\)/, 'real navigation must await its checkpoint');
assert.match(contextSource, /if \(saved\) router\.push/, 'failed checkpoints must not navigate');
assert.match(contextSource, /completeSetup\(payload\)/, 'completion must send the whole atomic setup payload');

const patientContextSource = fs.readFileSync(
  path.resolve(__dirname, '../context/PatientContext.tsx'),
  'utf8',
);
assert.match(patientContextSource, /run\.api\.saveSetup\(input\)/, 'draft setup must use one server operation');
assert.match(patientContextSource, /run\.api\.completeSetup\(input\)/, 'final setup must use one server operation');

const profileStepsSource = fs.readFileSync(
  path.resolve(__dirname, '../components/onboarding/StepsProfile.tsx'),
  'utf8',
);
assert.match(profileStepsSource, /autoFocus/, 'numeric and date entry must request focus where supported');
assert.match(profileStepsSource, /ob-start-date-calendar/, 'real program timing must offer a calendar');

const settingsSource = fs.readFileSync(path.resolve(__dirname, '../app/account.tsx'), 'utf8');
assert.match(settingsSource, /account-program-start-calendar/, 'settings must edit the program start date');
assert.match(settingsSource, /account-starting-weight/, 'settings must edit the canonical starting weight');

const parsed = parsePatientProfile({
  firstName: 'Casey',
  lastName: 'Ortiz',
  email: 'casey@example.com',
  phone: '+15550001010',
  dateOfBirth: '1985-04-03',
  heightInches: 66,
  startingWeight: 205,
  currentWeight: 191,
  goalWeight: 165,
  timezone: 'America/New_York',
  programId: 'glp1',
  programStartDate: '2026-01-05',
  setupComplete: true,
});
assert.equal(parsed.firstName, 'Casey', 'the live API DTO must pass the mobile parser');
assert.throws(
  () => parsePatientProfile({ firstName: 'Casey' }),
  /live patient data/i,
  'missing canonical fields must fail closed',
);

console.log('✓ canonical patient profile checks passed');