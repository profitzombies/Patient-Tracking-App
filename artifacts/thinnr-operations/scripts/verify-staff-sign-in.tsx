import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import SignIn from '../src/pages/SignIn';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let failures = 0;
const check = (name: string, condition: boolean) => condition
  ? console.log(`  ok  ${name}`)
  : (failures += 1, console.error(`  FAIL ${name}`));
const text = (node: ReactTestInstance): string => node.children
  .map((child) => typeof child === 'string' ? child : text(child as ReactTestInstance))
  .join('');
const settle = async () => {
  for (let count = 0; count < 8; count += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3)); });
  }
};
const one = (root: ReactTestInstance, id: string) => root.findByProps({ 'data-testid': id });
const type = async (node: ReactTestInstance, value: string) => {
  await act(async () => node.props.onChange({ target: { value } }));
};
const click = async (node: ReactTestInstance) => {
  await act(async () => {
    if (node.props.onClick) node.props.onClick({ preventDefault() {} });
    else {
      let parent = node.parent;
      while (parent && parent.type !== 'form') parent = parent.parent;
      parent?.props.onSubmit({ preventDefault() {} });
    }
  });
  await settle();
};
async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Router hook={memoryLocation({ path: '/sign-in' }).hook}><SignIn /></Router>);
  });
  return renderer;
}

console.log('staff sign-in second factor');
const enterEmailCode = async (view: ReactTestRenderer) => {
  await type(one(view.root, 'input-auth-email'), 'staff@example.com');
  await click(one(view.root, 'button-auth-submit'));
  await type(one(view.root, 'input-auth-otp'), '123456');
  await click(one(view.root, 'button-auth-verify'));
};

{
  const verified: unknown[] = [];
  __setSession({
    supabaseEnabled: true,
    signIn() {},
    requestStaffCode: async () => ({ requestId: 'email-request', message: null, devCode: null, error: null }),
    verifyStaffCode: async () => ({ error: null, secondFactor: { stepToken: 'a'.repeat(64), mode: 'sms', destination: '•••-•••-1234' } }),
    startStaffPhoneStep: async () => ({ error: null, requestId: 'sms-request', destination: '•••-•••-1234', devCode: '654321' }),
    verifyStaffPhoneCode: async (input: unknown) => { verified.push(input); return { error: null }; },
  });
  const view = await render();
  await enterEmailCode(view);
  check('sms mode auto-sends and renders destination', text(view.root).includes('•••-•••-1234') && Boolean(one(view.root, 'input-staff-sms-code')));
  await type(one(view.root, 'input-staff-sms-code'), '654321');
  await click(one(view.root, 'button-staff-sms-verify'));
  check('sms mode verifies the texted code', verified.length === 1);
  view.unmount();
}

{
  const starts: any[] = [];
  const verifies: any[] = [];
  __setSession({
    verifyStaffCode: async () => ({ error: null, secondFactor: { stepToken: 'b'.repeat(64), mode: 'enroll', destination: null } }),
    startStaffPhoneStep: async (input: unknown) => {
      starts.push(input);
      return { error: null, requestId: 'enroll-request', destination: '•••-•••-7788', devCode: null };
    },
    verifyStaffPhoneCode: async (input: unknown) => { verifies.push(input); return { error: null }; },
  });
  const view = await render();
  await enterEmailCode(view);
  await click(one(view.root, 'button-staff-phone-send'));
  const alert = one(view.root, 'text-auth-error');
  check('enroll requires a phone and announces the error', alert.props.role === 'alert' && text(alert).includes('mobile number'));
  await type(one(view.root, 'input-staff-phone'), '+15125557788');
  await click(one(view.root, 'button-staff-phone-send'));
  await type(one(view.root, 'input-staff-sms-code'), '112233');
  await click(one(view.root, 'button-staff-sms-verify'));
  check('enroll posts phone/start then phone/verify', starts[0]?.phone === '+15125557788' && verifies[0]?.code === '112233');
  view.unmount();
}

{
  __setSession({
    verifyStaffCode: async () => ({ error: null, secondFactor: { stepToken: 'c'.repeat(64), mode: 'sms', destination: '•••-•••-9999' } }),
    startStaffPhoneStep: async () => ({ error: 'Expired', code: 'STEP_EXPIRED' }),
  });
  const view = await render();
  await enterEmailCode(view);
  check('expired phone step returns to email with announced neutral copy', Boolean(one(view.root, 'input-auth-email')) && one(view.root, 'text-auth-error').props.role === 'alert' && text(view.root).includes('Start again with your email'));
  view.unmount();
}

console.log(failures ? `\n${failures} staff sign-in check(s) failed.` : '\nAll staff sign-in checks passed.');
process.exit(failures ? 1 : 0);