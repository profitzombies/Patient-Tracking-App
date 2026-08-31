import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const accountDetailSource = readFileSync(
  new URL('../src/pages/admin/AccountDetail.tsx', import.meta.url),
  'utf8',
);
const drillInSource = readFileSync(
  new URL('../src/pages/admin/OfficeDrillIn.tsx', import.meta.url),
  'utf8',
);

assert.match(
  accountDetailSource,
  /<Link href=\{`\/admin\/accounts\/\$\{account\.id\}\/office`\}[^>]+data-testid="button-open-office"/,
  'every provider account must expose a real office-dashboard link',
);
assert.doesNotMatch(
  accountDetailSource,
  /No office dashboard yet|dashboard unlocks once patients/,
  'the account detail must not block zero-patient offices',
);

assert.doesNotMatch(
  drillInSource,
  /activePatientCount|No office dashboard yet|dashboard unlocks once patients/,
  'the drill-in route must not block an empty scoped account',
);
assert.match(drillInSource, /data-testid="banner-viewing-as"/);
assert.match(drillInSource, /data-testid="link-back-to-hq"/);
assert.match(
  drillInSource,
  /<ProviderScopeProvider account=\{account\}>[\s\S]*?<OfficeApp \/>[\s\S]*?<\/ProviderScopeProvider>/,
  'HQ drill-in must render the actual office portal inside the selected provider scope',
);

console.log('Empty provider office drill-in regression checks passed.');