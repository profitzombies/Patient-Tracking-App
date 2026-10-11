/**
 * Public legal pages without a session: /privacy, /terms, /health-data,
 * /support and /delete-account render from the bundled documents, show the
 * effective date + draft banner, and the deletion page drives the two-step
 * request with neutral copy, the already-pending branch and server errors.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Route, Router, Switch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import {
  LEGAL_DOCUMENTS_EFFECTIVE_DATE,
  LEGAL_DOCUMENTS_STATUS,
  LEGAL_DOCUMENTS_VERSION,
  draftNotice,
  formatEffectiveDate,
  legalDocument,
} from '@workspace/legal-documents';
import LegalDocumentPage from '../src/pages/public/legal/LegalDocumentPage';
import SupportPage from '../src/pages/public/legal/SupportPage';
import DeleteAccountPage from '../src/pages/public/legal/DeleteAccountPage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const text = (node: ReactTestInstance | ReactTestRenderer) => {
  const root = 'root' in node ? node.root : node;
  const output: string[] = [];
  const walk = (item: ReactTestInstance | string) => {
    if (typeof item === 'string') output.push(item);
    else item.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(root);
  return output.join('');
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
let queue: Array<Response | Error> = [];
const requests: Array<{ url: string; method: string; body: any }> = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
  const next = queue.shift();
  if (!next) throw new Error(`Unexpected fetch: ${url}`);
  if (next instanceof Error) throw next;
  return next;
};
async function settle(rounds = 5) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
}
// Mounted exactly as App.tsx does: flat routes ahead of the session provider,
// so nothing here depends on auth, personas or Supabase.
async function render(path: string) {
  const location = memoryLocation({ path });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <Router hook={location.hook}>
        <Switch>
          <Route path="/privacy">{() => <LegalDocumentPage slug="privacy" />}</Route>
          <Route path="/terms">{() => <LegalDocumentPage slug="terms" />}</Route>
          <Route path="/health-data">{() => <LegalDocumentPage slug="health-data" />}</Route>
          <Route path="/support" component={SupportPage} />
          <Route path="/delete-account" component={DeleteAccountPage} />
        </Switch>
      </Router>,
    );
  });
  await settle();
  return renderer;
}
const one = (root: ReactTestInstance, testId: string) => root.find((node) => node.props['data-testid'] === testId);
const maybe = (root: ReactTestInstance, testId: string) => root.findAll((node) => node.props['data-testid'] === testId)[0] ?? null;
const change = async (node: ReactTestInstance, value: string) => act(async () => node.props.onChange({ target: { value } }));
const submit = async (form: ReactTestInstance) => { await act(async () => { form.props.onSubmit({ preventDefault() {} }); }); await settle(); };
const click = async (node: ReactTestInstance) => act(async () => node.props.onClick());

const effective = `Effective ${formatEffectiveDate(LEGAL_DOCUMENTS_EFFECTIVE_DATE)}`;
const banner = draftNotice(LEGAL_DOCUMENTS_STATUS);

for (const [path, slug, title] of [
  ['/privacy', 'privacy', 'Privacy Policy'],
  ['/terms', 'terms', 'Terms of Use'],
  ['/health-data', 'health-data', 'Health data notice'],
] as const) {
  console.log(`legal public: ${path}`);
  requests.length = 0;
  const view = await render(path);
  const body = text(view);
  check(`${path} renders without any request`, requests.length === 0);
  check(`${path} carries the document title`, view.root.findAllByType('h1').some((node) => text(node) === title));
  check(`${path} shows the effective date and version`, text(one(view.root, 'legal-effective-date')).includes(effective) && body.includes(LEGAL_DOCUMENTS_VERSION));
  check(
    `${path} draft banner follows the status flag`,
    banner ? text(one(view.root, 'legal-draft-banner')) === banner : maybe(view.root, 'legal-draft-banner') === null,
  );
  const headings = legalDocument(slug).markdown.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());
  check(`${path} renders every section heading (${headings.length})`, headings.every((heading) => view.root.findAllByType('h2').some((node) => text(node) === heading)));
  check(`${path} renders no raw markdown markers`, !body.includes('**') && !/\]\(/.test(body) && !body.includes('\n# '));
  check(`${path} marks itself current in the legal nav`, view.root.findAll((node) => node.type === 'a' && node.props['aria-current'] === 'page').length === 1);
  view.unmount();
}

console.log('\nlegal public: health data notice matches the permission scope');
{
  const notice = legalDocument('health-data').markdown;
  check('reads weight and steps only', /\*\*Weight\*\*/.test(notice) && /\*\*Steps\*\*/.test(notice));
  check('states it never writes', /never writes/i.test(notice));
  check('names both platforms', notice.includes('Apple Health') && notice.includes('Health Connect'));
}

console.log('\nlegal public: /support');
{
  requests.length = 0;
  queue = [json(200, { organizationName: 'THINNR', email: 'help@trythinnr.com', phone: '+1 555 010 0100' })];
  const view = await render('/support');
  check('support asks the public contact route', requests[0]?.url === '/api/legal/support');
  check('shows the configured email as a mailto', one(view.root, 'support-email').props.href === 'mailto:help@trythinnr.com?subject=THINNR%20app%20support' && text(one(view.root, 'support-email')) === 'help@trythinnr.com');
  check('shows the configured phone', text(one(view.root, 'support-phone')) === '+1 555 010 0100');
  check('links the policies and the deletion page', ['~/privacy', '~/terms', '~/health-data', '~/delete-account'].every((href) => view.root.findAll((node) => node.props.href === href).length > 0));
  view.unmount();

  queue = [new Error('offline')];
  const fallback = await render('/support');
  check('contact outage keeps the default address on screen', text(one(fallback.root, 'support-email')) === 'support@trythinnr.com' && maybe(fallback.root, 'support-phone') === null);
  fallback.unmount();
}

console.log('\nlegal public: /delete-account files a request');
{
  requests.length = 0;
  const view = await render('/delete-account');
  const body = text(view);
  check('explains deleted vs kept data', body.includes('Kept by your office') && body.includes('Financial records') && body.includes('Clinical record'));
  check('identify copy never confirms an account', body.includes('If an account matches') && body.includes('never confirm whether an account exists'));
  await submit(one(view.root, 'delete-identify-form'));
  check('empty identifier is rejected locally', requests.length === 0 && text(view).includes('Enter the email address or mobile number'));
  await change(one(view.root, 'input-delete-identifier'), ' pat@example.com ');
  queue = [json(200, { ok: true, requestId: 'req-1', devCode: null })];
  await submit(one(view.root, 'delete-identify-form'));
  check('start posts the trimmed identifier', requests[0]?.method === 'POST' && requests[0]?.url === '/api/account-deletion/start' && requests[0]?.body.identifier === 'pat@example.com');
  check('code step stays neutral', text(one(view.root, 'delete-code-sent')).startsWith('If an account matches pat@example.com'));
  check('no dev code line in production mode', maybe(view.root, 'delete-dev-code') === null);
  await change(one(view.root, 'input-delete-code'), '12ab');
  await submit(one(view.root, 'delete-code-form'));
  check('short code is rejected locally', requests.length === 1 && text(view).includes('Enter the 6-digit code.'));
  await change(one(view.root, 'input-delete-code'), '123456');
  queue = [json(400, { error: "That code didn't match or has expired. Check it and try again." })];
  await submit(one(view.root, 'delete-code-form'));
  check('server code error is shown and the form stays', text(view).includes("That code didn't match") && maybe(view.root, 'delete-code-form') !== null);
  const purgeAfter = '2026-10-18T15:00:00.000Z';
  queue = [json(202, { ok: true, alreadyPending: false, deletion: { requestedAt: '2026-10-11T15:00:00.000Z', purgeAfter, status: 'pending' } })];
  await submit(one(view.root, 'delete-code-form'));
  check('verify posts request id and code', requests.at(-1)?.url === '/api/account-deletion/verify' && JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ requestId: 'req-1', code: '123456' }));
  const filed = text(one(view.root, 'delete-filed-grace'));
  check('filed result shows the grace end date', filed.includes('permanently deleted after') && filed.includes('2026'));
  check('cancel-within-grace instruction is present', text(view).includes('Keep my account'));
  view.unmount();
}

console.log('\nlegal public: /delete-account already pending');
{
  requests.length = 0;
  const view = await render('/delete-account');
  await change(one(view.root, 'input-delete-identifier'), '6175550100');
  queue = [json(200, { ok: true, requestId: 'req-2', devCode: '654321' })];
  await submit(one(view.root, 'delete-identify-form'));
  check('development code is surfaced when the server returns one', text(one(view.root, 'delete-dev-code')).includes('654321'));
  await change(one(view.root, 'input-delete-code'), '654321');
  queue = [json(200, { ok: true, alreadyPending: true, deletion: { requestedAt: '2026-10-09T15:00:00.000Z', purgeAfter: '2026-10-16T15:00:00.000Z', status: 'pending' } })];
  await submit(one(view.root, 'delete-code-form'));
  const pending = text(one(view.root, 'delete-pending-grace'));
  check('pending result shows the existing grace end and files nothing new', pending.includes('already set to be deleted after') && pending.includes('2026') && pending.includes('Nothing new was filed'));
  check('no filed heading on the pending branch', maybe(view.root, 'delete-filed-grace') === null);
  view.unmount();
}

console.log('\nlegal public: /delete-account start over and outages');
{
  requests.length = 0;
  const view = await render('/delete-account');
  await change(one(view.root, 'input-delete-identifier'), 'pat@example.com');
  queue = [json(429, { error: 'Too many requests. Try again later.', retryable: true })];
  await submit(one(view.root, 'delete-identify-form'));
  check('rate limit message is shown on the identify step', text(view).includes('Too many requests') && maybe(view.root, 'delete-identify-form') !== null);
  queue = [new Error('offline')];
  await submit(one(view.root, 'delete-identify-form'));
  check('network failure has a plain message', text(view).includes('Could not reach THINNR'));
  queue = [json(200, { ok: true, requestId: 'req-3', devCode: null })];
  await submit(one(view.root, 'delete-identify-form'));
  await click(one(view.root, 'button-delete-start-over'));
  check('start over returns to the identify step', maybe(view.root, 'delete-identify-form') !== null && maybe(view.root, 'delete-code-form') === null);
  view.unmount();
}

console.log(failures ? `\n${failures} legal public check(s) failed.` : '\nAll legal public checks passed.');
process.exit(failures ? 1 : 0);
