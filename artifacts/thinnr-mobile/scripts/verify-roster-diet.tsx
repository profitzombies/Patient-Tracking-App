/**
 * Provider app read-only diet facts: the pure three-way helpers
 * (unknown / no diet / known) and the real DietRowLine + DietFactsCard
 * rendered under react-test-renderer. The owner's rule under test: an unknown
 * "% fits diet" reads as "Unknown", never "0%", and the pending-block and
 * severe-allergy badges appear on both the roster row and the record card.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:roster-diet
 */
import React from 'react';
import { check, finish, mount, one, section, STAFF, text } from './payments-stubs/harness';
import { DietFactsCard, DietRowLine } from '../components/office/DietFacts';
import { dietDisplayName, dietRowSummary, fitsDietDisplay, phaseLabel } from '../lib/roster-diet';
import type { RosterDietFacts } from '../lib/office-roster-api';

const KNOWN: RosterDietFacts = {
  diet: { slug: 'mediterranean', name: 'Mediterranean', startedAt: '2026-09-01T00:00:00Z' },
  pendingBlock: null,
  severeAllergy: false,
  fitsDietPct: 80,
  fitsDietSample: 15,
  fitWindowDays: 14,
};
const NO_DIET: RosterDietFacts = { diet: null, pendingBlock: null, severeAllergy: true, fitsDietPct: null, fitsDietSample: 0, fitWindowDays: 14 };
const BLOCKED: RosterDietFacts = {
  diet: { slug: 'just_tracking', name: 'Just tracking', startedAt: null },
  pendingBlock: { id: 'blk-1', createdAt: '2026-10-09T10:00:00Z' },
  severeAllergy: true,
  fitsDietPct: null,
  fitsDietSample: 0,
  fitWindowDays: 14,
};

async function main() {
  section('Pure helpers — three-way model');
  check('unknown family reads Unknown', dietDisplayName(null) === 'Unknown' && dietDisplayName(undefined) === 'Unknown');
  check('null diet is a real "No diet"', dietDisplayName(NO_DIET) === 'No diet');
  check('known diet uses the library name', dietDisplayName(KNOWN) === 'Mediterranean');
  check('just_tracking slug renders Just tracking', dietDisplayName(BLOCKED) === 'Just tracking');
  check('phase badge: protocol with week', phaseLabel('protocol', 2) === 'Protocol · wk 2' && phaseLabel('protocol', null) === 'Protocol');
  check('phase badge: maintenance and unknown', phaseLabel('maintenance') === 'Maintenance' && phaseLabel(null) === null && phaseLabel(undefined) === null);
  const knownFit = fitsDietDisplay(KNOWN);
  check('known fit renders a percent with its sample', knownFit.known && knownFit.text === '80%' && knownFit.detail === '15 scored foods · last 14 days', JSON.stringify(knownFit));
  const unknownFit = fitsDietDisplay(null);
  check('missing family fit is Unknown, never 0%', !unknownFit.known && unknownFit.text === 'Unknown' && unknownFit.detail === 'Diet facts did not load', JSON.stringify(unknownFit));
  const noDietFit = fitsDietDisplay(NO_DIET);
  check('no-diet fit is Unknown with its own reason', !noDietFit.known && noDietFit.text === 'Unknown' && noDietFit.detail === 'No diet chosen');
  const noSampleFit = fitsDietDisplay({ ...KNOWN, fitsDietPct: null, fitsDietSample: 0 });
  check('diet without scored foods is Unknown (not 0%)', !noSampleFit.known && noSampleFit.text === 'Unknown' && noSampleFit.detail === 'No scored foods logged yet');
  check('zero percent is a real figure', fitsDietDisplay({ ...KNOWN, fitsDietPct: 0, fitsDietSample: 1 }).text === '0%' && fitsDietDisplay({ ...KNOWN, fitsDietPct: 0, fitsDietSample: 1 }).detail === '1 scored food · last 14 days');
  check('row summary joins diet · phase · fit', dietRowSummary(KNOWN, 'protocol', 2) === 'Mediterranean · Protocol · wk 2 · 80% fits', dietRowSummary(KNOWN, 'protocol', 2));
  check('row summary for unknown family', dietRowSummary(null, null) === 'Unknown · fit unknown', dietRowSummary(null, null));

  section('DietRowLine — roster row');
  {
    const known = await mount(<DietRowLine patientId="p1" facts={KNOWN} stage="maintenance" />, STAFF);
    check('known row shows the summary line', text(known.root, 'diet-row-p1') === 'Mediterranean · Maintenance · 80% fits', text(known.root, 'diet-row-p1'));
    check('known row has no badges', !one(known.root, 'pending-block-p1') && !one(known.root, 'severe-allergy-p1'));
    await known.unmount();

    const blocked = await mount(<DietRowLine patientId="p2" facts={BLOCKED} stage="protocol" week={1} />, STAFF);
    check('pending block badge rides the row', !!one(blocked.root, 'pending-block-p2') && text(blocked.root, 'pending-block-p2') === 'BLOCK PENDING');
    check('severe allergy badge rides the row', !!one(blocked.root, 'severe-allergy-p2') && text(blocked.root, 'severe-allergy-p2') === 'SEVERE ALLERGY');
    check('blocked row still prints fit unknown', text(blocked.root, 'diet-row-p2').includes('Just tracking · Protocol · wk 1 · fit unknown'), text(blocked.root, 'diet-row-p2'));
    await blocked.unmount();

    const unknown = await mount(<DietRowLine patientId="p3" facts={null} stage={null} />, STAFF);
    check('unknown row reads Unknown and shows no badges', text(unknown.root, 'diet-row-p3') === 'Unknown · fit unknown' && !one(unknown.root, 'pending-block-p3') && !one(unknown.root, 'severe-allergy-p3'));
    await unknown.unmount();
  }

  section('DietFactsCard — patient record');
  {
    const known = await mount(<DietFactsCard patientId="p1" facts={KNOWN} stage="protocol" week={3} />, STAFF);
    const card = text(known.root, 'diet-card-p1');
    check('card names the diet', text(known.root, 'diet-name-p1') === 'Mediterranean');
    check('card shows the phase badge', card.includes('Protocol · wk 3'));
    check('card shows the fit percent and sample', text(known.root, 'fits-diet-p1') === '80%' && card.includes('15 scored foods · last 14 days'));
    check('card says nothing pending when clean', card.includes('Nothing pending') && !one(known.root, 'pending-block-p1'));
    check('card points writes at the web app', card.includes('made in the office web app'));
    await known.unmount();

    const blocked = await mount(<DietFactsCard patientId="p2" facts={BLOCKED} stage="protocol" week={1} />, STAFF);
    check('card shows both badges', !!one(blocked.root, 'pending-block-p2') && !!one(blocked.root, 'severe-allergy-p2') && !text(blocked.root, 'diet-card-p2').includes('Nothing pending'));
    check('card fit is Unknown for no scored foods', text(blocked.root, 'fits-diet-p2') === 'Unknown');
    await blocked.unmount();

    const unknown = await mount(<DietFactsCard patientId="p3" facts={null} stage={null} />, STAFF);
    const unknownCard = text(unknown.root, 'diet-card-p3');
    check('unknown card reads Unknown for diet and fit', text(unknown.root, 'diet-name-p3') === 'Unknown' && text(unknown.root, 'fits-diet-p3') === 'Unknown');
    check('unknown card never claims nothing pending', !unknownCard.includes('Nothing pending') && unknownCard.includes('Diet facts did not load'));
    check('unknown card shows no badges', !one(unknown.root, 'pending-block-p3') && !one(unknown.root, 'severe-allergy-p3'));
    await unknown.unmount();
  }

  finish('roster-diet');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
