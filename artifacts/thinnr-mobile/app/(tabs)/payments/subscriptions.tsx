import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { Field, RadioGroup, Sheet } from '@/components/payments/dialogs';
import { Body, Button, ChipRow, DetailList, Empty, ErrorBox, InlineNotice, LoadingBox, MoneyText, Pager, Panel, StatusPill } from '@/components/payments/primitives';
import { useOfficeBillingMutation, useOfficePrices, useOfficeSubscriptions } from '@/hooks/useOfficeBilling';
import { useColors } from '@/hooks/useColors';
import { officeBilling } from '@/lib/office-billing-api';
import { CADENCE_LABEL, formatCents, formatDate, SUBSCRIPTION_STATUS_LABEL, subscriptionTone } from '@/lib/office-billing-format';
import type { OfficePrice, SubscriptionChangeQuote, SubscriptionRow } from '@/lib/office-billing-types';
import { fonts } from '@/constants/colors';

const TITLE = 'Product subscriptions';
const SUB = 'Products that renew every 4 weeks.';
const PAGE_SIZE = 10;
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Payment failed' },
  { value: 'paused', label: 'Paused' },
  { value: 'incomplete', label: 'Awaiting payment' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'canceled', label: 'Canceled' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

export default function SubscriptionsScreen() {
  return (
    <PaymentsScreen
      section="subscriptions"
      title={TITLE}
      sub={SUB}
      live={(ctx) => <LiveSubscriptions ctx={ctx} />}
    />
  );
}

function initialFilter(value: string | string[] | undefined): Filter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return FILTERS.some((option) => option.value === candidate) ? candidate as Filter : 'all';
}

function LiveSubscriptions({ ctx }: { ctx: PaymentsLive }) {
  const params = useLocalSearchParams<{ status?: string | string[] }>();
  const [filter, setFilter] = useState<Filter>(() => initialFilter(params.status));
  const [page, setPage] = useState(1);
  // Pausing is represented by paused_at while Stripe/our DB status remains
  // active. Ask the server for active rows for both chips, then split them
  // locally; the subscriptions endpoint only supports equality on status.
  const requestStatus = filter === 'all' ? null : filter === 'paused' ? 'active' : filter;
  const query = useOfficeSubscriptions(ctx.userId, { status: requestStatus });
  const prices = useOfficePrices(ctx.userId);
  if (query.isPending || prices.isPending) return <LoadingBox label="Loading subscriptions…" testID="subscriptions-loading" />;
  if (query.isError || prices.isError || !query.data || !prices.data) {
    const failed = query.isError ? query : prices;
    return <ErrorBox error={failed.error} retry={() => void failed.refetch()} testID="subscriptions-error" />;
  }
  const items = filter === 'paused'
    ? query.data.items.filter((row) => row.paused_at != null)
    : filter === 'active'
      ? query.data.items.filter((row) => row.paused_at == null)
      : query.data.items;
  return (
    <>
      <ChipRow
        options={FILTERS}
        value={filter}
        onChange={(next) => { setFilter(next); setPage(1); }}
        label="Subscription status"
        testIDPrefix="subscriptions-filter"
      />
      <SubscriptionsView
        items={items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
        products={prices.data.products}
        userId={ctx.userId}
      />
      <Pager page={page} pageSize={PAGE_SIZE} total={items.length} onPage={setPage} testIDPrefix="subscriptions-pager" />
    </>
  );
}

function SubscriptionsView({ items, products, userId }: {
  items: SubscriptionRow[];
  products: OfficePrice[];
  userId: string;
}) {
  return (
    <Panel title="Subscriptions" testID="subscriptions-list">
      {!items.length ? <Empty testID="subscriptions-empty">No subscriptions match this status.</Empty> : null}
      {items.map((row) => <SubscriptionCard key={row.id} row={row} products={products} userId={userId} />)}
    </Panel>
  );
}

type Notice = { tone: 'good' | 'bad'; text: string } | null;

function SubscriptionCard({ row, products, userId }: { row: SubscriptionRow; products: OfficePrice[]; userId: string }) {
  const colors = useColors();
  const [notice, setNotice] = useState<Notice>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTiming, setCancelTiming] = useState<'later' | 'now'>('later');
  const [confirm, setConfirm] = useState('');
  const [changeOpen, setChangeOpen] = useState(false);
  const [nextProduct, setNextProduct] = useState('');
  const [quote, setQuote] = useState<SubscriptionChangeQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const failed = row.status === 'past_due' || row.status === 'unpaid';
  const live = row.status !== 'canceled';
  const eligible = useMemo(() => products.filter((product) =>
    product.active && product.offered && product.subscription_enabled && product.sell_price_cents != null && product.product_id !== row.product_id), [products, row.product_id]);

  const action = (
    success: string,
    run: (scope: { userId: string; signal?: AbortSignal }) => Promise<unknown>,
  ) => useOfficeBillingMutation(userId, (_: void, scope) => run(scope), {
    onSuccess: () => setNotice({ tone: 'good', text: success }),
    onError: (error) => setNotice({ tone: 'bad', text: error.message }),
  });
  const pause = action('Subscription paused', (scope) => officeBilling.pauseSubscription(row.id, scope));
  const resume = action('Subscription resumed', (scope) => officeBilling.resumeSubscription(row.id, scope));
  const retry = action('Payment retry started', (scope) => officeBilling.retrySubscriptionPayment(row.id, scope));
  const resend = action('Payment link emailed', (scope) => officeBilling.resendSubscriptionPaymentEmail(row.id, scope));
  const cancel = useOfficeBillingMutation(userId, (later: boolean, scope) =>
    officeBilling.cancelSubscription(row.id, { at_period_end: later }, scope), {
    onSuccess: (_data, later) => {
      setCancelOpen(false);
      setNotice({ tone: 'good', text: later ? 'Subscription ends at period end' : 'Subscription canceled' });
    },
    onError: (error) => setNotice({ tone: 'bad', text: error.message }),
  });
  const quoteMutation = useOfficeBillingMutation(userId, (productId: string, scope) =>
    officeBilling.subscriptionChangeQuote(row.id, productId, scope), {
    invalidate: false,
    onSuccess: (result) => setQuote(result),
    onError: (error) => setQuoteError(error.message || 'Quote could not be loaded.'),
  });
  const change = useOfficeBillingMutation(userId, (productId: string, scope) =>
    officeBilling.changeSubscription(row.id, { product_id: productId }, scope), {
    onSuccess: () => {
      setChangeOpen(false);
      setNotice({ tone: 'good', text: 'Product change scheduled' });
    },
    onError: (error) => setQuoteError(error.message),
  });
  const chooseProduct = (productId: string) => {
    setNextProduct(productId);
    setQuote(null);
    setQuoteError('');
    if (productId) quoteMutation.mutate(productId);
  };

  return (
    <View testID={`subscription-row-${row.id}`} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
      <View style={styles.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.patient, { color: colors.navy }]}>{row.payer.name}</Text>
          {row.payer.email ? <Body>{row.payer.email}</Body> : null}
        </View>
        <StatusPill tone={subscriptionTone(row.status)}>{SUBSCRIPTION_STATUS_LABEL[row.status]}</StatusPill>
      </View>
      <Text style={[styles.product, { color: colors.text }]}>{row.product_name}</Text>
      <Body>{formatCents(row.unit_price_cents + row.shipping_charge_cents)} · {CADENCE_LABEL[4]}</Body>
      {row.shipping_charge_cents > 0 ? <Body>Includes {formatCents(row.shipping_charge_cents)} shipping</Body> : null}
      <DetailList items={[
        { label: 'Started', value: formatDate(row.created_at) },
        { label: row.cancel_at_period_end && live ? 'Period end' : 'Next renewal', value: `${row.cancel_at_period_end && live ? 'Ends ' : ''}${formatDate(row.current_period_end)}` },
        { label: 'Renewals', value: String(row.renewals) },
      ]} />
      {row.paused_at ? <InlineNotice tone="warn">{`Paused since ${formatDate(row.paused_at)}`}</InlineNotice> : null}
      {failed ? (
        <InlineNotice tone="bad" testID={`subscription-failure-${row.id}`}>{`Card declined ${row.payment_failure_count} ${row.payment_failure_count === 1 ? 'time' : 'times'}, last on ${formatDate(row.last_payment_failed_at)}${row.last_failure_message ? `. ${row.last_failure_message}` : ''}`}</InlineNotice>
      ) : null}
      {row.pending_change ? <Body>Changes to {row.pending_change.product_name} ({formatCents(row.pending_change.unit_price_cents)}) on {formatDate(row.pending_change.effective_at)}</Body> : null}
      {live ? (
        <View style={styles.actions}>
          {failed ? <Button small label="Retry payment" busy={retry.isPending} onPress={() => retry.mutate()} testID={`button-retry-payment-${row.id}`} /> : null}
          {failed ? <Button small label="Email patient a payment link" busy={resend.isPending} onPress={() => resend.mutate()} testID={`button-resend-payment-email-${row.id}`} /> : null}
          <Button small label={row.paused_at ? 'Resume' : 'Pause'} busy={pause.isPending || resume.isPending} onPress={() => row.paused_at ? resume.mutate() : pause.mutate()} testID={`button-${row.paused_at ? 'resume' : 'pause'}-${row.id}`} />
          <Button small label="Change product" onPress={() => { setChangeOpen(true); setNextProduct(''); setQuote(null); setQuoteError(''); }} testID={`button-change-product-${row.id}`} />
          {!row.cancel_at_period_end ? <Button small label="Cancel subscription…" variant="danger" onPress={() => { setCancelTiming('later'); setConfirm(''); setCancelOpen(true); }} testID={`button-cancel-subscription-${row.id}`} /> : null}
        </View>
      ) : null}
      {notice ? <InlineNotice tone={notice.tone} testID={`subscription-notice-${row.id}`}>{notice.text}</InlineNotice> : null}

      <Sheet
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel subscription"
        sub={`${row.payer.name}'s ${row.product_name} subscription (${formatCents(row.unit_price_cents + row.shipping_charge_cents)} every 4 weeks).`}
        testID={`cancel-subscription-sheet-${row.id}`}
        footer={<>
          <Button small label="Keep subscription" onPress={() => setCancelOpen(false)} testID={`button-keep-subscription-${row.id}`} />
          <Button
            small
            variant="danger"
            label={cancelTiming === 'later' ? 'Cancel at period end' : 'Cancel now'}
            disabled={confirm.trim().toUpperCase() !== 'CANCEL'}
            busy={cancel.isPending}
            onPress={() => cancel.mutate(cancelTiming === 'later')}
            testID={`button-cancel-subscription-confirm-${row.id}`}
          />
        </>}
      >
        <RadioGroup
          label="When should it end?"
          value={cancelTiming}
          onChange={setCancelTiming}
          testIDPrefix={`radio-cancel-${row.id}`}
          options={[
            { value: 'later', label: 'At the end of the current period', hint: row.current_period_end ? `Stays active through ${formatDate(row.current_period_end)}, then stops renewing.` : 'Finishes the paid period, then stops renewing.' },
            { value: 'now', label: 'Immediately', hint: 'Ends today. The remaining days in the paid period are not refunded automatically.' },
          ]}
        />
        <InlineNotice tone="bad">Danger zone. This cannot be undone from here. Type CANCEL to confirm.</InlineNotice>
        <Field label="Type CANCEL to confirm" value={confirm} onChangeText={setConfirm} placeholder="CANCEL" autoCapitalize="characters" testID={`input-cancel-confirm-${row.id}`} />
      </Sheet>

      <Sheet
        open={changeOpen}
        onClose={() => setChangeOpen(false)}
        title="Change product"
        sub="Choose the product this subscription should use at its next renewal."
        testID={`change-product-sheet-${row.id}`}
        footer={<>
          <Button small label="Close" onPress={() => setChangeOpen(false)} testID={`button-close-change-${row.id}`} />
          <Button small label="Confirm change" variant="primary" disabled={!quote} busy={change.isPending} onPress={() => change.mutate(nextProduct)} testID={`button-confirm-change-${row.id}`} />
        </>}
      >
        {!eligible.length ? <Empty>No other subscription products are available.</Empty> : (
          <RadioGroup
            label="New product"
            value={nextProduct}
            onChange={chooseProduct}
            testIDPrefix={`change-product-option-${row.id}`}
            options={eligible.map((product) => ({ value: product.product_id, label: `${product.name} · ${formatCents(product.sell_price_cents)}` }))}
          />
        )}
        {quoteMutation.isPending ? <LoadingBox label="Loading quote…" testID={`subscription-change-quote-loading-${row.id}`} /> : null}
        {quote ? (
          <View testID={`subscription-change-quote-${row.id}`} style={[styles.quote, { borderColor: colors.border }]}>
            <Body muted={false}>Current: {quote.current.product_name} · {formatCents(quote.current.unit_price_cents)}</Body>
            <Body muted={false}>Next: {quote.next.product_name} · {formatCents(quote.next.unit_price_cents)}</Body>
            <Body>Shipping: {formatCents(quote.next.shipping_charge_cents)}</Body>
            <Body>Takes effect at next renewal on {formatDate(quote.effective_at)}</Body>
          </View>
        ) : null}
        {quoteError ? <InlineNotice tone="bad" testID={`subscription-change-error-${row.id}`}>{quoteError}</InlineNotice> : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  patient: { fontSize: 17, fontFamily: fonts.serifBold },
  product: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  quote: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 5 },
});
