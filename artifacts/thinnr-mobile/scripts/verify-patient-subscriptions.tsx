/**
 * Subscriptions list + detail contract check: signed-out holding frame,
 * live list/detail, and every self-service action's request
 * shape (move next, skip, pause/resume, cancel with confirmation, address,
 * plan, card, retry payment with and without a different card), each
 * confirming via the notice and re-reading the record.
 */
import {
  alerts, assert, billingCalls, calls, confirms, finish, has, isDisabled, mount, opened, press, section, setConfirmAnswer, setRoute, text, type, unmount,
} from './patient-billing-stubs/harness';
import React, { act } from 'react';
import SubscriptionsScreen from '../app/my-subscriptions/index';
import SubscriptionDetailScreen from '../app/my-subscriptions/[id]';
import { SAMPLE_SUBSCRIPTIONS } from './fixtures/sample-patient-billing';
import { moveWindow } from '../lib/patient-billing-core';
import { setSearchParams } from './patient-billing-stubs/expo-router';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { announcements } from './onboarding-gate-stubs/react-native';

const session: StubSession = { access_token: 'patient-token', user: { id: 'user-1' } };
const SUB_ID = '44444444-4444-4444-8444-444444444444';
const address = { name: 'Pat Example', line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', phone: null };
const cards = [
  { id: 'pm_visa', brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029, is_default: true },
  { id: 'pm_amex', brand: 'amex', last4: '0005', exp_month: 11, exp_year: 2028, is_default: false },
];
const nextShipment = new Date(); nextShipment.setDate(nextShipment.getDate() + 20); nextShipment.setHours(9, 0, 0, 0);
const row = (over: Record<string, unknown> = {}) => ({
  id: SUB_ID, product_name: 'Control', product_id: 'p1', unit_price_cents: 6299, shipping_charge_cents: 1000,
  status: 'active', paused: false, current_period_end: nextShipment.toISOString(), cancel_at_period_end: false,
  last_hosted_invoice_url: null, last_failure_message: null, cadence_weeks: 4, quantity: 1,
  next_shipment_at: nextShipment.toISOString(), shipping_address: address,
  shipping: { method: 'standard', source: 'fallback', carrier_service_name: null, delivery_window_start: null, delivery_window_end: null },
  card: cards[0], offered_cadences_weeks: [4, 8], ...over,
});

let current: Record<string, unknown> = row();
let actionFailure: { status: number; message: string } | null = null;
let cardsFailure = false;
setRoute(call => {
  if (call.path === 'patient-data/billing/subscriptions' && call.method === 'GET') {
    return { body: { items: [current, row({ id: '55555555-5555-4555-8555-555555555555', product_name: 'Hydrate', status: 'canceled', next_shipment_at: null })] } };
  }
  if (call.path === `patient-data/billing/subscriptions/${SUB_ID}` && call.method === 'GET') return { body: current };
  if (call.path === 'patient-data/billing/cards') return cardsFailure ? { status: 503, body: { error: 'Cards unavailable.' } } : { body: { cards, default_payment_method_id: 'pm_visa' } };
  const action = call.path.match(new RegExp(`^patient-data/billing/subscriptions/${SUB_ID}/([a-z-]+)$`))?.[1];
  if (action && call.method === 'POST') {
    if (actionFailure) return { status: actionFailure.status, body: { error: actionFailure.message } };
    const body = call.body ?? {};
    if (action === 'move-next') current = { ...current, next_shipment_at: `${body.next_shipment_at as string}T12:00:00.000Z` };
    if (action === 'skip-next') { const d = new Date(nextShipment); d.setDate(d.getDate() + 28); current = { ...current, next_shipment_at: d.toISOString() }; }
    if (action === 'pause') current = { ...current, paused: true };
    if (action === 'resume') current = { ...current, paused: false };
    if (action === 'cancel') current = { ...current, cancel_at_period_end: true };
    if (action === 'address') current = { ...current, shipping_address: body.shipping_address };
    if (action === 'plan') current = { ...current, ...(body.cadence_weeks ? { cadence_weeks: body.cadence_weeks } : {}), ...(body.quantity ? { quantity: body.quantity } : {}) };
    if (action === 'card') current = { ...current, card: cards.find(card => card.id === body.payment_method_id) };
    if (action === 'retry-payment') current = { ...current, status: 'active', last_failure_message: null, ...(body.payment_method_id ? { card: cards.find(card => card.id === body.payment_method_id) } : {}) };
    return { body: current };
  }
  return undefined;
});

const detailGets = () => billingCalls().filter(call => call.method === 'GET' && call.path === `patient-data/billing/subscriptions/${SUB_ID}`).length;
const posts = (action: string) => billingCalls().filter(call => call.method === 'POST' && call.path.endsWith(`/${action}`));
const lastNotice = () => announcements[announcements.length - 1] ?? '';

async function main() {
  section('signed out renders nothing and fetches nothing');
  setStubSession(null);
  let tree = await mount(<SubscriptionsScreen />);
  const before = calls.length;
  assert('signed-out list makes no request and shows no subscriptions or demo note', calls.length === before && has(tree, 'screen-subscriptions') && !has(tree, 'screen-subscriptions-demo-note') && SAMPLE_SUBSCRIPTIONS.every(sub => !has(tree, `card-subscription-${sub.id}`)));
  await unmount(tree);
  setSearchParams({ id: SUB_ID });
  tree = await mount(<SubscriptionDetailScreen />);
  assert('signed-out detail makes no request and offers no write controls', calls.length === before && !has(tree, 'badge-subscription-status') && !has(tree, 'button-cancel') && alerts.length === 0 && confirms === 0);
  await unmount(tree);

  section('live list and detail');
  await act(async () => setStubSession(session));
  tree = await mount(<SubscriptionsScreen />);
  assert('live list renders current and ended sections', has(tree, `card-subscription-${SUB_ID}`) && text(tree, 'screen-subscriptions').includes('ENDED') && text(tree, 'card-subscription-55555555-5555-4555-8555-555555555555-status') === 'Canceled');
  await unmount(tree);

  setSearchParams({ id: SUB_ID });
  tree = await mount(<SubscriptionDetailScreen />);
  assert('detail GETs the subscription with bearer and renders it', billingCalls().some(call => call.path === `patient-data/billing/subscriptions/${SUB_ID}` && call.auth === 'Bearer patient-token') && text(tree, 'badge-subscription-status') === 'Active' && text(tree, 'text-subscription-card').includes('4242'));
  assert('live write controls are enabled', ['button-move-next', 'button-skip-next', 'button-change-plan', 'button-change-address', 'button-change-card', 'button-pause', 'button-cancel'].every(id => !isDisabled(tree, id)));

  section('move next shipment');
  await press(tree, 'button-move-next');
  assert('move panel opens with the date picker bounded to the allowed window', has(tree, 'panel-move') && has(tree, 'move-date'));
  const picker = tree.root.findAllByProps({ testID: 'move-date' }).find(node => typeof node.props.onChange === 'function' && node.props.minDate);
  const range = moveWindow(new Date());
  assert('picker min/max are tomorrow and +365 days', picker?.props.minDate === range.min && picker?.props.maxDate === range.max);
  assert('submit stays disabled until the date changes', isDisabled(tree, 'button-move-submit'));
  const target = new Date(); target.setDate(target.getDate() + 30);
  const targetKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  await act(async () => picker!.props.onChange(targetKey));
  let gets = detailGets();
  await press(tree, 'button-move-submit');
  assert('move-next POSTs the chosen day, announces, and re-reads', posts('move-next')[0]?.body?.next_shipment_at === targetKey && posts('move-next')[0]?.idempotencyKey !== null && lastNotice().startsWith('Next shipment moved to') && detailGets() === gets + 1 && !has(tree, 'panel-move'));
  assert('notice snackbar renders with a dismiss action', has(tree, 'screen-subscription-notice'));
  await press(tree, 'screen-subscription-notice-dismiss');
  assert('dismissing hides the notice', !has(tree, 'screen-subscription-notice'));

  section('skip, pause, resume');
  gets = detailGets();
  setConfirmAnswer(false);
  await press(tree, 'button-skip-next');
  assert('skip asks first; declining sends nothing', confirms === 1 && posts('skip-next').length === 0);
  setConfirmAnswer(true);
  await press(tree, 'button-skip-next');
  assert('confirmed skip-next POSTs an empty body and re-reads', confirms === 2 && posts('skip-next').length === 1 && JSON.stringify(posts('skip-next')[0].body) === '{}' && lastNotice().includes('skipped') && detailGets() === gets + 1);
  await press(tree, 'button-pause');
  assert('pause POSTs and the screen flips to paused', posts('pause').length === 1 && text(tree, 'badge-subscription-status') === 'Paused' && has(tree, 'button-resume') && isDisabled(tree, 'button-move-next') && isDisabled(tree, 'button-skip-next'));
  await press(tree, 'button-resume');
  assert('resume POSTs and scheduling returns', posts('resume').length === 1 && text(tree, 'badge-subscription-status') === 'Active' && !isDisabled(tree, 'button-move-next') && lastNotice().startsWith('Subscription resumed'));

  section('plan, address, card');
  await press(tree, 'button-change-plan');
  assert('plan panel offers the offered cadences and quantity stepper', has(tree, 'panel-plan') && has(tree, 'cadence-8') && has(tree, 'quantity-inc') && isDisabled(tree, 'button-plan-submit'));
  await press(tree, 'cadence-8');
  await press(tree, 'quantity-inc');
  await press(tree, 'button-plan-submit');
  assert('plan POSTs only the changed fields and re-renders', JSON.stringify(posts('plan')[0]?.body) === JSON.stringify({ cadence_weeks: 8, quantity: 2 }) && text(tree, 'card-plan').includes('Every 8 weeks') && text(tree, 'card-plan').includes('2 units') && text(tree, 'text-subscription-total') === '$135.98');

  await press(tree, 'button-change-address');
  assert('address panel is prefilled', has(tree, 'panel-address') && tree.root.findAllByProps({ testID: 'input-address-line1' }).some(node => node.props.value === '1 Main St'));
  await type(tree, 'input-address-city', '');
  assert('missing required field blocks save and says which', isDisabled(tree, 'button-address-submit') && text(tree, 'text-address-missing').includes('city'));
  await type(tree, 'input-address-city', 'Dallas');
  await type(tree, 'input-address-line2', 'Suite 9');
  await type(tree, 'input-address-state', 'tx');
  await press(tree, 'button-address-submit');
  const sent = posts('address')[0]?.body?.shipping_address as Record<string, unknown> | undefined;
  assert('address POSTs the full normalized address', sent?.city === 'Dallas' && sent?.line2 === 'Suite 9' && sent?.state === 'TX' && sent?.country === 'US' && sent?.phone === null && text(tree, 'card-address').includes('Dallas, TX 78701'));

  await press(tree, 'button-change-card');
  assert('card picker lists saved cards from the cards endpoint and marks the current one', billingCalls().some(call => call.path === 'patient-data/billing/cards') && has(tree, 'picker-card-option-pm_visa') && has(tree, 'picker-card-option-pm_amex') && text(tree, 'picker-card-option-pm_visa').includes('Current'));
  await press(tree, 'picker-card-option-pm_amex');
  await press(tree, 'picker-card-submit');
  assert('card POSTs the chosen payment method and the summary updates', posts('card')[0]?.body?.payment_method_id === 'pm_amex' && text(tree, 'text-subscription-card').includes('0005') && lastNotice() === 'Renewal card updated.');

  section('cancel at period end with confirmation');
  setConfirmAnswer(false);
  await press(tree, 'button-cancel');
  assert('declining the confirmation sends nothing', confirms === 3 && posts('cancel').length === 0 && text(tree, 'badge-subscription-status') === 'Active');
  setConfirmAnswer(true);
  await press(tree, 'button-cancel');
  assert('confirming POSTs cancel, shows the end date and hides further scheduling', posts('cancel').length === 1 && text(tree, 'badge-subscription-status').startsWith('Ends') && has(tree, 'text-cancel-scheduled') && !has(tree, 'button-cancel') && isDisabled(tree, 'button-move-next'));
  await unmount(tree);

  section('failed renewal: retry with card');
  current = row({ status: 'past_due', last_failure_message: 'Your card was declined.', last_hosted_invoice_url: 'https://invoice.stripe.test/i' });
  tree = await mount(<SubscriptionDetailScreen />);
  assert('failure card leads with the message and retry paths; scheduling is off', has(tree, 'card-payment-failed') && text(tree, 'text-payment-failure').includes('declined') && !isDisabled(tree, 'button-retry-payment') && isDisabled(tree, 'button-move-next') && !isDisabled(tree, 'button-change-card'));
  actionFailure = { status: 402, message: 'Your card was declined again.' };
  await press(tree, 'button-retry-payment');
  assert('a declined retry surfaces the server message, record stays failed', JSON.stringify(posts('retry-payment')[0]?.body) === '{}' && text(tree, 'screen-subscription-error').includes('declined again') && has(tree, 'card-payment-failed'));
  actionFailure = null;
  await press(tree, 'button-retry-with-card');
  assert('retry-with-card opens the saved-card picker', has(tree, 'picker-retry-card') && has(tree, 'picker-retry-card-option-pm_amex'));
  await press(tree, 'picker-retry-card-option-pm_amex');
  await press(tree, 'picker-retry-card-submit');
  assert('retry POSTs the chosen card, clears the error, and the record recovers', posts('retry-payment')[1]?.body?.payment_method_id === 'pm_amex' && !has(tree, 'screen-subscription-error') && !has(tree, 'card-payment-failed') && text(tree, 'badge-subscription-status') === 'Active' && lastNotice().startsWith('Payment submitted'));
  await unmount(tree);

  current = row({ status: 'past_due', last_failure_message: 'Declined.', last_hosted_invoice_url: 'https://invoice.stripe.test/i' });
  tree = await mount(<SubscriptionDetailScreen />);
  await press(tree, 'button-pay-invoice');
  assert('hosted invoice fallback opens the Stripe page', opened.includes('https://invoice.stripe.test/i'));
  cardsFailure = true;
  await press(tree, 'button-retry-with-card');
  assert('a cards load failure shows inline, never an empty picker', text(tree, 'picker-retry-card-error').includes('Cards unavailable') && !has(tree, 'picker-retry-card-empty'));
  cardsFailure = false;
  await unmount(tree);

  section('email deep link: ?action=skip');
  current = row();
  const skipsBefore = posts('skip-next').length;
  const confirmsBefore = confirms;
  setSearchParams({ id: SUB_ID, action: 'skip' });
  setConfirmAnswer(true);
  tree = await mount(<SubscriptionDetailScreen />);
  assert('a skip link confirms once and posts skip-next once after the live record loads', confirms === confirmsBefore + 1 && posts('skip-next').length === skipsBefore + 1 && lastNotice().includes('skipped'));
  await unmount(tree);
  current = row({ cancel_at_period_end: true });
  tree = await mount(<SubscriptionDetailScreen />);
  assert('a skip link that no longer applies explains itself instead of failing silently', text(tree, 'screen-subscription-error').includes('can no longer be skipped') && posts('skip-next').length === skipsBefore + 1 && confirms === confirmsBefore + 1);
  await unmount(tree);
  setStubSession(null);
  setSearchParams({ id: SUB_ID, action: 'skip' });
  const alertsBefore = alerts.length;
  tree = await mount(<SubscriptionDetailScreen />);
  assert('a skip link while signed out neither confirms, nudges nor posts', alerts.length === alertsBefore && confirms === confirmsBefore + 1 && posts('skip-next').length === skipsBefore + 1);
  await unmount(tree);
  await act(async () => setStubSession(session));
  setSearchParams({ id: SUB_ID });

  section('load failure');
  current = row();
  setRoute(() => ({ status: 503, body: { error: 'Subscriptions are briefly unavailable.' } }));
  tree = await mount(<SubscriptionDetailScreen />);
  assert('load failure shows the error and a retry, no record', text(tree, 'screen-subscription-error').includes('briefly unavailable') && has(tree, 'screen-subscription-retry') && !has(tree, 'card-subscription-summary'));
  await unmount(tree);

  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
