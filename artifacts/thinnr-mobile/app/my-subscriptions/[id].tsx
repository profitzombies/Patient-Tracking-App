import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ChipGrid,
  FieldLabel,
  GhostButton,
  LedgerInput,
  PrimaryButton,
  StepperRow,
} from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { LocalDatePicker } from '@/components/ui/LocalDatePicker';
import { BillingScreen, SectionLabel } from '@/components/billing/BillingScreen';
import { KeyValue, ToneBadge } from '@/components/billing/BillingPieces';
import { confirmDestructive, openExternal } from '@/components/billing/actions';
import { useBillingNotice } from '@/components/billing/useBillingNotice';
import { useBillingResource } from '@/components/billing/useBillingResource';
import { useColors } from '@/hooks/useColors';
import {
  cancelSubscription,
  changeSubscriptionAddress,
  changeSubscriptionPlan,
  getSubscription,
  listCards,
  moveNextShipment,
  pauseSubscription,
  resumeSubscription,
  retrySubscriptionPayment,
  skipNextShipment,
  updateSubscriptionCard,
} from '@/lib/patient-billing-api';
import {
  addressLines,
  arrivalWindow,
  cadenceLabel,
  cardLabel,
  dateKey,
  errorMessage,
  money,
  moveWindow,
  quantityLabel,
  shortDate,
  shippingChoiceLabel,
  subscriptionActions,
  subscriptionCadenceLine,
  subscriptionStatus,
} from '@/lib/patient-billing-core';
import type {
  PatientBillingSubscription,
  PatientCard,
  PatientSubscriptionDetail,
  ShippingAddress,
} from '@/lib/patient-billing-types';

type Panel = 'move' | 'address' | 'plan' | 'card' | 'retry-card' | null;

const MAX_QUANTITY = 10;

export default function SubscriptionDetailScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ id?: string | string[]; action?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] ?? '' : params.id ?? '';
  const linkedAction = Array.isArray(params.action) ? params.action[0] : params.action;
  const load = useCallback(() => getSubscription(id), [id]);
  const subscription = useBillingResource<PatientSubscriptionDetail>(load);
  const notice = useBillingNotice();
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cards, setCards] = useState<PatientCard[] | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const row = subscription.data;
  const actions = row ? subscriptionActions(row) : null;
  const status = row ? subscriptionStatus(row) : null;
  const appAccess = row?.kind === 'app_access';

  useEffect(() => {
    if (panel !== 'card' && panel !== 'retry-card') return;
    let active = true;
    setCardsError(null);
    listCards()
      .then(result => { if (active) setCards(result.cards); })
      .catch(caught => { if (active) setCardsError(errorMessage(caught)); });
    return () => { active = false; };
  }, [panel]);

  /**
   * Every write: post, merge the returned row so the screen updates at
   * once, confirm (snackbar + announcement), then re-read the full record
   * so card and offered cadences reflect server truth.
   */
  const mutate = (key: string, work: () => Promise<PatientBillingSubscription>, confirmation: (updated: PatientBillingSubscription) => string) => {
    setBusy(key);
    subscription.setError(null);
    void (async () => {
      try {
        const updated = await work();
        subscription.setData(current => (current ? { ...current, ...updated } : current));
        setPanel(null);
        notice.announce(confirmation(updated));
        await subscription.reload();
      } catch (caught) {
        subscription.setError(errorMessage(caught));
      } finally {
        setBusy(null);
      }
    })();
  };


  const confirmSkip = (target: PatientBillingSubscription) => confirmDestructive({
    title: 'Skip this shipment?',
    message: `Skip the ${target.product_name} shipment on ${shortDate(target.next_shipment_at)}? Your following shipment stays on schedule.`,
    confirmLabel: 'Skip shipment',
    keepLabel: 'Keep it',
  }, () => mutate('skip', () => skipNextShipment(target.id), updated => `Next shipment skipped. The following one ships ${shortDate(updated.next_shipment_at)}.`));
  const skip = () => { if (row) confirmSkip(row); };

  // Email deep links (/my-subscriptions/<id>?action=skip) open the skip
  // confirmation once the live record is in; a link that no longer applies
  // explains itself instead of failing silently.
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    if (linkedAction !== 'skip' || !row || subscription.loading) return;
    const key = `${row.id}:${linkedAction}`;
    if (handledLink.current === key) return;
    handledLink.current = key;
    if (subscriptionActions(row).skipNext && row.next_shipment_at) confirmSkip(row);
    else subscription.setError('That shipment can no longer be skipped from this link. Manage the plan below.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedAction, row?.id, subscription.loading]);
  const pause = () => { if (row) mutate('pause', () => pauseSubscription(row.id), () => 'Subscription paused. Nothing ships or charges until you resume.'); };
  const resume = () => { if (row) mutate('resume', () => resumeSubscription(row.id), updated => `Subscription resumed. Next shipment ${shortDate(updated.next_shipment_at)}.`); };
  const cancel = () => {
    if (!row) return;
    confirmDestructive({
      title: 'Cancel at the end of this period?',
      message: appAccess
        ? `You keep the AI features through ${shortDate(row.current_period_end)}. After that they lock until you subscribe again.`
        : `You keep your ${row.product_name} shipments through ${shortDate(row.current_period_end)}. Nothing renews after that.`,
      confirmLabel: 'Cancel subscription',
      keepLabel: 'Keep subscription',
    }, () => mutate('cancel', () => cancelSubscription(row.id), updated => `Subscription ends ${shortDate(updated.current_period_end)}.`));
  };
  const retry = (paymentMethodId?: string) => {
    if (!row) return;
    mutate('retry', () => retrySubscriptionPayment(row.id, paymentMethodId ? { payment_method_id: paymentMethodId } : {}), () => 'Payment submitted. Your subscription updates as soon as the charge clears.');
  };

  return (
    <BillingScreen
      title={row ? row.product_name : 'Subscription'}
      testID="screen-subscription"
      loading={subscription.loading}
      error={subscription.error}
      onRetry={() => void subscription.reload()}
      hasContent={row !== null}
      notice={notice.notice}
      onDismissNotice={notice.dismiss}
    >
      {row && actions && status ? (
        <>
          <LedgerCard testID="card-subscription-summary" style={styles.card}>
            <View style={styles.between}>
              <View style={styles.grow}>
                <Text style={[styles.cardTitle, { color: colors.navy }]}>{row.product_name}</Text>
                <Text style={[styles.hint, { color: colors.subtleText }]}>{subscriptionCadenceLine(row)}</Text>
              </View>
              <ToneBadge testID="badge-subscription-status" label={status.label} tone={status.tone} />
            </View>
            {appAccess ? (
              <View style={[styles.totals, { borderTopColor: colors.border }]}>
                <KeyValue label="Per renewal" value={money(row.unit_price_cents)} testID="text-subscription-total" emphasis />
              </View>
            ) : (
              <View style={[styles.totals, { borderTopColor: colors.border }]}>
                <KeyValue label={`${quantityLabel(row.quantity)} × ${money(row.unit_price_cents)}`} value={money(row.unit_price_cents * row.quantity)} />
                <KeyValue label="Shipping" value={money(row.shipping_charge_cents)} />
                <KeyValue label="Per shipment" value={money(row.unit_price_cents * row.quantity + row.shipping_charge_cents)} testID="text-subscription-total" emphasis />
              </View>
            )}
            {appAccess ? (
              <Text testID="text-app-access-covers" style={[styles.hint, { color: colors.subtleText }]}>
                Covers the AI coach, photo and menu reads, and barcode lookup. Food logging, your shop and care-team chat are always included.
              </Text>
            ) : (
              <Text testID="text-subscription-shipping-method" style={[styles.hint, { color: colors.subtleText }]}>
                {shippingChoiceLabel(row.shipping)}
                {row.shipping.source === 'live' && arrivalWindow(row.shipping.delivery_window_start, row.shipping.delivery_window_end)
                  ? ` · ${arrivalWindow(row.shipping.delivery_window_start, row.shipping.delivery_window_end)}`
                  : ''}
              </Text>
            )}
            {row.status !== 'canceled' ? (
              <Text testID="text-next-shipment" style={[styles.body, styles.gapSm, { color: colors.bodyText }]}>
                {appAccess
                  ? row.cancel_at_period_end
                    ? `Access continues through ${shortDate(row.next_shipment_at)}. Nothing renews after that.`
                    : actions.retryPayment
                      ? `The renewal due ${shortDate(row.next_shipment_at)} is unpaid. Your AI features stay locked until payment clears.`
                      : `Renews ${shortDate(row.next_shipment_at)}.`
                  : row.cancel_at_period_end
                    ? `Last shipment ${shortDate(row.next_shipment_at)}. Nothing renews after that.`
                    : row.paused
                      ? `Paused. When you resume, the next shipment is ${shortDate(row.next_shipment_at)}.`
                      : actions.retryPayment
                        ? `The renewal due ${shortDate(row.next_shipment_at)} is unpaid. It ships once payment clears.`
                        : `Next shipment ${shortDate(row.next_shipment_at)}.`}
              </Text>
            ) : (
              <Text style={[styles.body, styles.gapSm, { color: colors.bodyText }]}>This subscription has ended.</Text>
            )}
            <Text testID="text-subscription-card" style={[styles.hint, { color: colors.subtleText }]}>
              {row.card ? `Charged to ${cardLabel(row.card)}` : 'No card saved for renewals yet.'}
            </Text>
          </LedgerCard>

          {actions.retryPayment ? (
            <LedgerCard testID="card-payment-failed" style={[styles.card, { borderColor: colors.riskBorder, backgroundColor: colors.riskBg }]}>
              <View style={styles.row}>
                <Feather name="alert-circle" size={16} color={colors.riskText} />
                <Text style={[styles.panelTitle, { color: colors.riskText }]}>Renewal payment failed</Text>
              </View>
              <Text testID="text-payment-failure" style={[styles.body, styles.gapSm, { color: colors.riskText }]}>
                {row.last_failure_message ?? 'The last renewal charge did not go through.'}
                {row.card ? ` Card on file: ${cardLabel(row.card)}.` : ''}
              </Text>
              <View style={styles.buttonRow}>
                <PrimaryButton
                  testID="button-retry-payment"
                  label={busy === 'retry' ? 'Retrying…' : 'Retry payment'}
                  accessibilityLabel="Retry the failed renewal payment with the card on file"
                  disabled={busy !== null}
                  onPress={() => retry()}
                  style={styles.buttonGrow}
                />
                <GhostButton
                  testID="button-retry-with-card"
                  label="Use another card"
                  accessibilityLabel="Retry the failed payment with a different saved card"
                  disabled={busy !== null}
                  onPress={() => setPanel(panel === 'retry-card' ? null : 'retry-card')}
                  style={styles.buttonGrow}
                />
              </View>
              {row.last_hosted_invoice_url ? (
                <Pressable
                  testID="button-pay-invoice"
                  accessibilityRole="link"
                  accessibilityLabel="Pay this invoice on Stripe"
                  onPress={() => void openExternal(row.last_hosted_invoice_url!).catch(caught => subscription.setError(errorMessage(caught)))}
                  style={styles.linkRow}
                >
                  <Text style={[styles.link, { color: colors.cobalt }]}>Pay on Stripe instead</Text>
                  <Feather name="external-link" size={13} color={colors.cobalt} />
                </Pressable>
              ) : null}
              {panel === 'retry-card' ? (
                <CardPicker
                  testID="picker-retry-card"
                  cards={cards}
                  error={cardsError}
                  currentId={row.card?.id ?? null}
                  busy={busy !== null}
                  actionLabel="Retry with this card"
                  onChoose={cardId => retry(cardId)}
                />
              ) : null}
            </LedgerCard>
          ) : null}

          {row.status !== 'canceled' && !appAccess ? (
            <>
              <SectionLabel text="Shipments" />
              <LedgerCard testID="card-shipment-controls" style={styles.card}>
                <View style={styles.buttonRow}>
                  <GhostButton
                    testID="button-move-next"
                    label="Move next shipment"
                    disabled={!actions.moveNext || busy !== null}
                    onPress={() => setPanel(panel === 'move' ? null : 'move')}
                    style={styles.buttonGrow}
                  />
                  <GhostButton
                    testID="button-skip-next"
                    label={busy === 'skip' ? 'Skipping…' : 'Skip next shipment'}
                    disabled={!actions.skipNext || busy !== null}
                    onPress={skip}
                    style={styles.buttonGrow}
                  />
                </View>
                {panel === 'move' ? (
                  <MovePanel
                    current={row.next_shipment_at}
                    busy={busy === 'move'}
                    onSubmit={key => mutate('move', () => moveNextShipment(row.id, { next_shipment_at: key }), updated => `Next shipment moved to ${shortDate(updated.next_shipment_at)}.`)}
                  />
                ) : null}
                {!actions.moveNext && !actions.skipNext && (row.paused || row.cancel_at_period_end) ? (
                  <Text style={[styles.hint, styles.gapSm, { color: colors.subtleText }]}>
                    {row.paused ? 'Resume the subscription to change shipment dates.' : 'Shipment dates are fixed once a subscription is set to end.'}
                  </Text>
                ) : null}
              </LedgerCard>

              <SectionLabel text="Plan" />
              <LedgerCard testID="card-plan" style={styles.card}>
                <KeyValue label="Cadence" value={cadenceLabel(row.cadence_weeks)} />
                <KeyValue label="Quantity" value={quantityLabel(row.quantity)} />
                <GhostButton
                  testID="button-change-plan"
                  label="Change cadence or quantity"
                  disabled={!actions.plan || busy !== null}
                  onPress={() => setPanel(panel === 'plan' ? null : 'plan')}
                  style={styles.gapSm}
                />
                {panel === 'plan' ? (
                  <PlanPanel
                    cadence={row.cadence_weeks}
                    quantity={row.quantity}
                    offered={row.offered_cadences_weeks}
                    busy={busy === 'plan'}
                    onSubmit={input => mutate('plan', () => changeSubscriptionPlan(row.id, input), updated => `Plan updated: ${cadenceLabel(updated.cadence_weeks)}, ${quantityLabel(updated.quantity)}.`)}
                  />
                ) : null}
              </LedgerCard>

              <SectionLabel text="Shipping address" />
              <LedgerCard testID="card-address" style={styles.card}>
                {addressLines(row.shipping_address).map((line, index) => (
                  <Text key={`${index}-${line}`} style={[styles.body, { color: colors.bodyText }]}>{line}</Text>
                ))}
                <GhostButton
                  testID="button-change-address"
                  label="Change address"
                  disabled={!actions.address || busy !== null}
                  onPress={() => setPanel(panel === 'address' ? null : 'address')}
                  style={styles.gapSm}
                />
                {panel === 'address' ? (
                  <AddressPanel
                    initial={row.shipping_address}
                    busy={busy === 'address'}
                    onSubmit={address => mutate('address', () => changeSubscriptionAddress(row.id, { shipping_address: address }), () => 'Shipping address updated for future shipments.')}
                  />
                ) : null}
              </LedgerCard>

            </>
          ) : null}

          {row.status !== 'canceled' ? (
            <>
              <SectionLabel text="Payment" />
              <LedgerCard testID="card-payment" style={styles.card}>
                <Text style={[styles.body, { color: colors.bodyText }]}>{row.card ? cardLabel(row.card) : 'No card saved for renewals yet.'}</Text>
                <GhostButton
                  testID="button-change-card"
                  label="Update card"
                  disabled={!actions.card || busy !== null}
                  onPress={() => setPanel(panel === 'card' ? null : 'card')}
                  style={styles.gapSm}
                />
                {panel === 'card' ? (
                  <CardPicker
                    testID="picker-card"
                    cards={cards}
                    error={cardsError}
                    currentId={row.card?.id ?? null}
                    busy={busy !== null}
                    actionLabel="Use this card"
                    onChoose={cardId => mutate('card', () => updateSubscriptionCard(row.id, { payment_method_id: cardId }), () => 'Renewal card updated.')}
                  />
                ) : null}
              </LedgerCard>

              <SectionLabel text={appAccess ? 'Cancel' : 'Pause or cancel'} />
              <View style={styles.buttonRow}>
                {appAccess ? null : actions.resume ? (
                  <PrimaryButton testID="button-resume" label={busy === 'resume' ? 'Resuming…' : 'Resume subscription'} disabled={busy !== null} onPress={resume} style={styles.buttonGrow} />
                ) : (
                  <GhostButton testID="button-pause" label={busy === 'pause' ? 'Pausing…' : 'Pause'} disabled={!actions.pause || busy !== null} onPress={pause} style={styles.buttonGrow} />
                )}
                {actions.cancel ? (
                  <GhostButton testID="button-cancel" label={busy === 'cancel' ? 'Canceling…' : 'Cancel at period end'} disabled={busy !== null} onPress={cancel} style={styles.buttonGrow} />
                ) : null}
              </View>
              {row.cancel_at_period_end ? (
                <Text testID="text-cancel-scheduled" style={[styles.hint, styles.gapSm, { color: colors.subtleText }]}>
                  {appAccess
                    ? `Cancellation is scheduled for ${shortDate(row.current_period_end)}. Your AI features stay on until then.`
                    : `Cancellation is scheduled for ${shortDate(row.current_period_end)}.`}
                </Text>
              ) : null}
            </>
          ) : null}

          <GhostButton testID="button-view-orders" label="View order history" onPress={() => router.push('/orders' as never)} style={styles.gap} />
        </>
      ) : null}
    </BillingScreen>
  );
}

function MovePanel({ current, busy, onSubmit }: { current: string | null; busy: boolean; onSubmit: (dateKey: string) => void }) {
  const colors = useColors();
  const range = moveWindow(new Date());
  const currentKey = current ? dateKey(new Date(current)) : null;
  const [value, setValue] = useState(currentKey && currentKey >= range.min && currentKey <= range.max ? currentKey : range.min);
  const unchanged = value === currentKey;
  return (
    <View testID="panel-move" style={[styles.panel, { borderTopColor: colors.border }]}>
      <FieldLabel text="New shipment date" />
      <Text style={[styles.hint, { color: colors.subtleText, marginBottom: 8 }]}>Pick any day from tomorrow up to a year out. Your card is charged on that day.</Text>
      <LocalDatePicker testID="move-date" value={value} onChange={setValue} minDate={range.min} maxDate={range.max} />
      <PrimaryButton
        testID="button-move-submit"
        label={busy ? 'Moving…' : `Move to ${shortDate(`${value}T12:00:00`)}`}
        accessibilityLabel="Confirm the new shipment date"
        disabled={busy || unchanged}
        onPress={() => onSubmit(value)}
        style={styles.gapSm}
      />
    </View>
  );
}

function PlanPanel({ cadence, quantity, offered, busy, onSubmit }: {
  cadence: number;
  quantity: number;
  offered: number[];
  busy: boolean;
  onSubmit: (input: { cadence_weeks?: number; quantity?: number }) => void;
}) {
  const colors = useColors();
  const cadences = offered.includes(cadence) ? offered : [cadence, ...offered];
  const [nextCadence, setNextCadence] = useState(cadence);
  const [nextQuantity, setNextQuantity] = useState(quantity);
  const changed = nextCadence !== cadence || nextQuantity !== quantity;
  return (
    <View testID="panel-plan" style={[styles.panel, { borderTopColor: colors.border }]}>
      {cadences.length > 1 ? (
        <>
          <FieldLabel text="Ships" />
          <ChipGrid
            testIDPrefix="cadence"
            options={cadences.map(weeks => ({ label: cadenceLabel(weeks), value: String(weeks) }))}
            value={String(nextCadence)}
            onChange={value => setNextCadence(Number(value))}
            basis="48%"
          />
        </>
      ) : (
        <Text style={[styles.hint, { color: colors.subtleText }]}>This product ships {cadenceLabel(cadence).toLowerCase()}.</Text>
      )}
      <StepperRow
        testID="quantity"
        label="Quantity per shipment"
        display={String(nextQuantity)}
        onDec={() => setNextQuantity(current => Math.max(1, current - 1))}
        onInc={() => setNextQuantity(current => Math.min(MAX_QUANTITY, current + 1))}
        decDisabled={nextQuantity <= 1}
        incDisabled={nextQuantity >= MAX_QUANTITY}
      />
      <PrimaryButton
        testID="button-plan-submit"
        label={busy ? 'Saving…' : 'Save plan'}
        disabled={busy || !changed}
        onPress={() => onSubmit({
          ...(nextCadence !== cadence ? { cadence_weeks: nextCadence } : {}),
          ...(nextQuantity !== quantity ? { quantity: nextQuantity } : {}),
        })}
        style={styles.gapSm}
      />
    </View>
  );
}

const ADDRESS_FIELDS: { key: keyof ShippingAddress; label: string; placeholder: string; required: boolean }[] = [
  { key: 'name', label: 'Full name', placeholder: 'Name on the package', required: true },
  { key: 'line1', label: 'Street address', placeholder: '100 Wellness Way', required: true },
  { key: 'line2', label: 'Apt, suite, unit (optional)', placeholder: '', required: false },
  { key: 'city', label: 'City', placeholder: 'Austin', required: true },
  { key: 'state', label: 'State', placeholder: 'TX', required: true },
  { key: 'postal_code', label: 'ZIP code', placeholder: '78701', required: true },
  { key: 'phone', label: 'Phone (optional)', placeholder: 'For delivery questions', required: false },
];

function AddressPanel({ initial, busy, onSubmit }: { initial: ShippingAddress; busy: boolean; onSubmit: (address: ShippingAddress) => void }) {
  const colors = useColors();
  const [draft, setDraft] = useState<ShippingAddress>(initial);
  const missing = ADDRESS_FIELDS.filter(field => field.required && !(draft[field.key] ?? '').toString().trim()).map(field => field.label);
  const set = (key: keyof ShippingAddress, value: string) => setDraft(current => ({ ...current, [key]: value }));
  return (
    <View testID="panel-address" style={[styles.panel, { borderTopColor: colors.border }]}>
      {ADDRESS_FIELDS.map(field => (
        <View key={field.key} style={styles.field}>
          <FieldLabel text={field.label} />
          <LedgerInput
            testID={`input-address-${field.key}`}
            value={draft[field.key] ?? ''}
            placeholder={field.placeholder}
            onChangeText={value => set(field.key, value)}
            autoCapitalize={field.key === 'state' ? 'characters' : 'words'}
            keyboardType={field.key === 'phone' ? 'phone-pad' : field.key === 'postal_code' ? 'number-pad' : 'default'}
          />
        </View>
      ))}
      <PrimaryButton
        testID="button-address-submit"
        label={busy ? 'Saving…' : 'Save address'}
        disabled={busy || missing.length > 0}
        onPress={() => onSubmit({
          ...draft,
          name: draft.name.trim(),
          line1: draft.line1.trim(),
          line2: draft.line2?.trim() ? draft.line2.trim() : null,
          city: draft.city.trim(),
          state: draft.state.trim().toUpperCase(),
          postal_code: draft.postal_code.trim(),
          country: draft.country || 'US',
          phone: draft.phone?.trim() ? draft.phone.trim() : null,
        })}
        style={styles.gapSm}
      />
      {missing.length ? <Text testID="text-address-missing" style={[styles.hint, { color: colors.subtleText }]}>Add {missing.join(', ').toLowerCase()} to save.</Text> : null}
    </View>
  );
}

function CardPicker({ testID, cards, error, currentId, busy, actionLabel, onChoose }: {
  testID: string;
  cards: PatientCard[] | null;
  error: string | null;
  currentId: string | null;
  busy: boolean;
  actionLabel: string;
  onChoose: (cardId: string) => void;
}) {
  const colors = useColors();
  const [selected, setSelected] = useState<string | null>(null);
  const choice = selected ?? cards?.find(card => card.id !== currentId)?.id ?? null;
  return (
    <View testID={testID} style={[styles.panel, { borderTopColor: colors.border }]}>
      <FieldLabel text="Saved cards" />
      {error ? <Text testID={`${testID}-error`} style={[styles.body, { color: colors.riskText }]}>{error}</Text> : null}
      {!cards && !error ? <Text style={[styles.hint, { color: colors.subtleText }]}>Loading cards…</Text> : null}
      {cards && cards.length === 0 ? (
        <Text testID={`${testID}-empty`} style={[styles.body, { color: colors.bodyText }]}>
          No other saved cards. Add a card at checkout in your office’s shop, then pick it here.
        </Text>
      ) : null}
      {cards?.map(card => {
        const active = card.id === choice;
        return (
          <Pressable
            key={card.id}
            testID={`${testID}-option-${card.id}`}
            accessibilityRole="radio"
            accessibilityLabel={`${cardLabel(card)}${card.id === currentId ? ', current card' : ''}`}
            accessibilityState={{ selected: active }}
            onPress={() => setSelected(card.id)}
            style={[styles.cardOption, { borderColor: active ? colors.cobalt : colors.border, backgroundColor: active ? colors.activeBg : colors.card }]}
          >
            <Feather name={active ? 'check-circle' : 'circle'} size={16} color={active ? colors.cobalt : colors.subtleText} />
            <Text style={[styles.body, styles.grow, { color: colors.navy }]}>{cardLabel(card)}</Text>
            {card.id === currentId ? <Text style={[styles.hint, { color: colors.subtleText }]}>Current</Text> : card.is_default ? <Text style={[styles.hint, { color: colors.subtleText }]}>Default</Text> : null}
          </Pressable>
        );
      })}
      {cards && cards.length > 0 ? (
        <PrimaryButton
          testID={`${testID}-submit`}
          label={busy ? 'Working…' : actionLabel}
          disabled={busy || !choice}
          onPress={() => choice && onChoose(choice)}
          style={styles.gapSm}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontFamily: 'PlayfairDisplay_700Bold' },
  panelTitle: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  hint: { fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  grow: { flex: 1 },
  gap: { marginTop: 18 },
  gapSm: { marginTop: 9 },
  totals: { borderTopWidth: 1, marginTop: 10, paddingTop: 8 },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 9 },
  buttonGrow: { flex: 1 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10, minHeight: 32 },
  link: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  panel: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  field: { marginBottom: 10 },
  cardOption: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 7, paddingHorizontal: 12, minHeight: 48, marginTop: 8 },
});
