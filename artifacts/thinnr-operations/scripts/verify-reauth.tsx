import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { __setSession } from './invite-stubs/supabase';
import { ReauthSheet } from '../src/components/security/ReauthSheet';
import {
  ReauthRequiredError,
  registerReauthHandler,
  withReauthRetry,
} from '../src/lib/reauth';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
const check = (name: string, ok: boolean) => {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
};
const text = (node: ReactTestInstance): string => node.children
  .map((child) => typeof child === 'string' ? child : text(child as ReactTestInstance))
  .join('');
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

console.log('reauth');

let calls = 0;
let prompts = 0;
let unregister = registerReauthHandler(async () => {
  prompts += 1;
  return true;
});
const retried = await withReauthRetry(async () => {
  calls += 1;
  return calls === 1
    ? response(401, { code: 'reauth_required' })
    : response(200, { ok: true });
});
check('retries exactly once and returns the retry response', calls === 2 && retried.status === 200 && prompts === 1);
unregister();

unregister = registerReauthHandler(async () => false);
let cancelled: unknown;
try {
  await withReauthRetry(async () => response(401, { code: 'reauth_required' }));
} catch (error) {
  cancelled = error;
}
check(
  'cancel throws the friendly ReauthRequiredError',
  cancelled instanceof ReauthRequiredError
    && cancelled.message === "Confirm it's you with a fresh code to continue.",
);
unregister();

let releasePrompt!: (confirmed: boolean) => void;
prompts = 0;
unregister = registerReauthHandler(() => {
  prompts += 1;
  return new Promise<boolean>((resolve) => {
    releasePrompt = resolve;
  });
});
const first = withReauthRetry(async () => response(401, { code: 'reauth_required' }));
const second = withReauthRetry(async () => response(401, { code: 'reauth_required' }));
for (let i = 0; i < 10 && !releasePrompt; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
releasePrompt(false);
await Promise.allSettled([first, second]);
check('concurrent gated calls share one prompt', prompts === 1);
unregister();

type ScriptedResponse = [number, Record<string, unknown>];
let responses: ScriptedResponse[] = [];
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
(globalThis as any).fetch = async (input: string | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.url;
  requests.push({
    url,
    body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
  });
  const next = responses.shift();
  if (!next) throw new Error(`Unexpected fetch: ${url}`);
  return response(next[0], next[1]);
};
__setSession('staff-token');

async function renderSheet(onResolve: (confirmed: boolean) => void): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ReauthSheet open onResolve={onResolve} />);
  });
  return renderer;
}

const click = async (node: ReactTestInstance) => {
  await act(async () => {
    node.props.onClick?.({ preventDefault() {} });
  });
  await settle();
};

let resolved: boolean | null = null;
responses = [
  [200, { ok: true, requestId: 'request-1', destination: 'a•••@x.com', devCode: '123456' }],
  [200, { ok: true, codeVerifiedAt: '2026-01-01T00:00:00Z', windowMinutes: 10 }],
];
let view = await renderSheet((confirmed) => {
  resolved = confirmed;
});
await click(view.root.findAll((node) => node.type === 'button' && text(node) === 'Send code')[0]);
const codeInput = view.root.findByProps({ 'data-testid': 'input-reauth-code' });
await act(async () => {
  codeInput.props.onChange({ target: { value: '123456' } });
});
await act(async () => {
  view.root.findByType('form').props.onSubmit({ preventDefault() {} });
});
await settle();
check(
  'sheet sends and verifies a code, then resolves true',
  resolved === true
    && requests.some((request) => request.url.endsWith('/reauth/start'))
    && requests.some((request) => request.url.endsWith('/reauth/verify') && request.body.code === '123456'),
);
view.unmount();

resolved = null;
view = await renderSheet((confirmed) => {
  resolved = confirmed;
});
await click(view.root.findByProps({ 'data-testid': 'button-reauth-cancel' }));
check('cancel resolves false', resolved === false);
view.unmount();

resolved = null;
responses = [
  [200, { ok: true, requestId: 'request-2', destination: 'a•••@x.com' }],
  [400, { error: 'That code is incorrect or has expired.' }],
];
view = await renderSheet((confirmed) => {
  resolved = confirmed;
});
await click(view.root.findAll((node) => node.type === 'button' && text(node) === 'Send code')[0]);
await act(async () => {
  view.root.findByProps({ 'data-testid': 'input-reauth-code' }).props.onChange({ target: { value: '000000' } });
});
await act(async () => {
  view.root.findByType('form').props.onSubmit({ preventDefault() {} });
});
await settle();
const alerts = view.root.findAllByProps({ role: 'alert' });
check(
  'wrong code shows the server error inline',
  resolved === null && alerts.some((alert) => text(alert).includes('That code is incorrect or has expired.')),
);
view.unmount();

console.log(failures ? `\n${failures} reauth check(s) failed.` : '\nAll reauth checks passed.');
process.exit(failures ? 1 : 0);