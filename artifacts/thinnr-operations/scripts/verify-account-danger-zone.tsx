import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import AccountDetail from '../src/pages/admin/AccountDetail';
import { AccountDangerZone } from '../src/components/admin/AccountDangerZone';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.getSelection ??= () => ({ toString: () => '' });

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const settle = async (ticks = 8) => {
  for (let index = 0; index < ticks; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
};

console.log('\ndanger zone disclosure');
{
  let mounts = 0;
  function StatefulChild() {
    const [draft, setDraft] = React.useState('');
    React.useEffect(() => { mounts += 1; }, []);
    return <input data-testid="stateful-draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<AccountDangerZone><StatefulChild /></AccountDangerZone>); });
  const root = renderer!.root;
  const toggle = byTestId(root, 'button-toggle-danger-zone')[0];
  const content = byTestId(root, 'danger-zone-content')[0];
  check('starts closed with native button disclosure semantics',
    toggle.type === 'button' && toggle.props.type === 'button' && toggle.props['aria-expanded'] === false &&
    Boolean(toggle.props['aria-controls']) && toggle.props['aria-controls'] === content.props.id && content.props.hidden === true);
  await act(async () => { toggle.props.onClick(); });
  const input = byTestId(root, 'stateful-draft')[0];
  await act(async () => { input.props.onChange({ target: { value: 'unfinished reason' } }); });
  await act(async () => { toggle.props.onClick(); });
  check('collapse hides rather than unmounting children', content.props.hidden === true && mounts === 1);
  await act(async () => { toggle.props.onClick(); });
  check('reopening preserves the child draft and mount', byTestId(root, 'stateful-draft')[0].props.value === 'unfinished reason' && mounts === 1);
  await act(async () => renderer!.unmount());
}

console.log('\naccount detail composition and route ownership');
{
  const loc = memoryLocation({ path: '/admin/accounts/office-1', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>
          <Route path="/admin/accounts/:id"><AccountDetail /></Route>
        </Router>
      </QueryClientProvider>,
    );
  });
  await settle();
  const root = renderer!.root;
  const staff = byTestId(root, 'stub-staff-access')[0];
  const zone = byTestId(root, 'section-danger-zone')[0];
  const tree = renderer!.toJSON();
  const serialized = JSON.stringify(tree);
  check('danger zone is at page bottom after staff access',
    serialized.indexOf('stub-staff-access') < serialized.indexOf('section-danger-zone'));
  check('sensitive workflows are mounted inside the closed zone',
    byTestId(zone, 'stub-offboarding').length === 1 && byTestId(zone, 'stub-bundle').length === 1 && byTestId(zone, 'stub-legal-hold').length === 1);
  check('staff and sensitive workflows receive the current provider',
    staff.props['data-provider-id'] === 'office-1' &&
    byTestId(zone, 'stub-offboarding')[0].props['data-office-id'] === 'office-1' &&
    byTestId(zone, 'stub-bundle')[0].props['data-office-id'] === 'office-1' &&
    byTestId(zone, 'stub-bundle')[0].props['data-office-name'] === 'Beacon Hill Aesthetics' &&
    byTestId(zone, 'stub-legal-hold')[0].props['data-target-kind'] === 'provider' &&
    byTestId(zone, 'stub-legal-hold')[0].props['data-target-id'] === 'office-1' &&
    byTestId(zone, 'stub-legal-hold')[0].props['data-provider-id'] === 'office-1');

  const buttons = zone.findAll((node) => node.type === 'button' && ['Offboard', 'Export', 'Legal hold'].includes(String(node.children[0])));
  check('actions remain independently available', buttons.find((node) => node.children[0] === 'Export')?.props.disabled !== true &&
    buttons.find((node) => node.children[0] === 'Offboard')?.props.disabled === true &&
    buttons.find((node) => node.children[0] === 'Legal hold')?.props.disabled === true);

  const toggle = byTestId(root, 'button-toggle-danger-zone')[0];
  await act(async () => { toggle.props.onClick(); });
  await act(async () => { byTestId(root, 'draft-bundle')[0].props.onChange({ target: { value: 'route one draft' } }); });
  await act(async () => { byTestId(root, 'button-lock-account')[0].props.onClick(); });
  check('first provider owns open disclosure, draft, and dialog state',
    toggle.props['aria-expanded'] === true && byTestId(root, 'draft-bundle')[0].props.value === 'route one draft' &&
    byTestId(root, 'dialog-lock-confirm').length === 1);

  await act(async () => { loc.navigate('/admin/accounts/office-2'); });
  await settle();
  check('actual provider route switch resets disclosure and dialog state',
    byTestId(root, 'button-toggle-danger-zone')[0].props['aria-expanded'] === false &&
    byTestId(root, 'danger-zone-content')[0].props.hidden === true &&
    byTestId(root, 'dialog-lock-confirm').length === 0);
  check('route switch remounts clean child state with new provider props',
    byTestId(root, 'draft-bundle')[0].props.value === '' &&
    byTestId(root, 'stub-bundle')[0].props['data-office-id'] === 'office-2' &&
    byTestId(root, 'stub-bundle')[0].props['data-office-name'] === 'Harbor Wellness');
  await act(async () => renderer!.unmount());
}

console.log(failures === 0 ? '\nall account danger-zone checks passed' : `\n${failures} account danger-zone check(s) failed`);
process.exit(failures === 0 ? 0 : 1);