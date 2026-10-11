/**
 * One office transaction with items, fees, shipping, payment references,
 * refunds, disputes and timeline. Live staff may issue an exact final refund.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { Field, MoneyField, RadioGroup, Sheet, Toggle } from '@/components/payments/dialogs';
import {
  Body,
  Button,
  DetailList,
  ErrorBox,
  FeeBreakdown,
  InlineNotice,
  LoadingBox,
  MoneyText,
  Panel,
  StatusPill,
  formatAddress,
} from '@/components/payments/primitives';
import { useOfficeBillingMutation, useOfficeOrder } from '@/hooks/useOfficeBilling';
import { officeBilling } from '@/lib/office-billing-api';
import {
  FULFILLMENT_LABEL,
  ORDER_STATUS_LABEL,
  centsToDollarsInput,
  formatCents,
  formatDateTime,
  fulfillmentTone,
  orderStatusTone,
  parseDollarsToCents,
} from '@/lib/office-billing-format';
import type { OrderDetail } from '@/lib/office-billing-types';
import { useColors } from '@/hooks/useColors';

type RefundPreset = 'remaining' | 'product' | 'product_shipping' | 'custom';

export default function TransactionDetailScreen() {
  const { orderId = '' } = useLocalSearchParams<{ orderId: string }>();
  return (
    <PaymentsScreen
      section="transactions"
      title="Transaction"
      sub="Order details and payment history."
      back={{ href: '/payments/transactions', label: 'Transactions' }}
      refresh="this transaction"
      live={(ctx) => <LiveDetail ctx={ctx} orderId={orderId} />}
    />
  );
}

function LiveDetail({ ctx, orderId }: { ctx: PaymentsLive; orderId: string }) {
  const query = useOfficeOrder(ctx.userId, orderId);
  if (query.isPending) {
    return <LoadingBox label="Loading transaction…" testID="transaction-loading" />;
  }
  // A failed re-read keeps the loaded record on screen (the shell shows a notice).
  if (!query.data) {
    return <ErrorBox error={query.error} retry={() => void query.refetch()} testID="transaction-error" />;
  }
  return <DetailView order={query.data} userId={ctx.userId} />;
}

function DetailView({
  order,
  userId,
}: {
  order: OrderDetail;
  userId: string;
}) {
  const colors = useColors();
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [success, setSuccess] = React.useState<string | null>(null);
  return (
    <>
      <View style={styles.top}>
        <StatusPill tone={orderStatusTone(order.status)}>{ORDER_STATUS_LABEL[order.status]}</StatusPill>
        <Button
          label="Refund"
          variant="danger"
          testID="button-refund-open"
          onPress={() => setRefundOpen(true)}
        />
      </View>
      {success ? <InlineNotice tone="good" testID="refund-success">{success}</InlineNotice> : null}
      <Panel title="Items">
        {order.items.map((item) => (
          <View key={item.id} style={styles.moneyRow}>
            <Text style={[styles.flex, { color: colors.text }]}>
              {item.product_name} × {item.quantity}
            </Text>
            <MoneyText cents={item.unit_price_cents * item.quantity} />
          </View>
        ))}
      </Panel>
      <Panel title="Fees and office net">
        <FeeBreakdown fees={order.fees} />
      </Panel>
      <Panel title="Shipping">
        {formatAddress(order.shipping_address).map((line) => (
          <Body key={line} muted={false}>{line}</Body>
        ))}
        <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>
          {FULFILLMENT_LABEL[order.fulfillment_status]}
        </StatusPill>
        {order.tracking_number ? (
          <Body>{order.carrier ?? 'Carrier'} · {order.tracking_number}</Body>
        ) : null}
      </Panel>
      <Panel title="Payment">
        <DetailList
          items={[
            { label: 'Payer', value: order.payer.name },
            { label: 'Email', value: order.payer.email ?? '—' },
            { label: 'Status', value: ORDER_STATUS_LABEL[order.status] },
            { label: 'Stripe invoice', value: order.stripe.invoice_id ?? '—' },
            { label: 'Payment intent', value: order.stripe.payment_intent_id ?? '—' },
          ]}
        />
      </Panel>
      {order.subscription_id ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open subscription"
          testID="link-order-subscription"
          onPress={() => router.push({
            pathname: '/payments/subscriptions',
            params: { subscriptionId: order.subscription_id! },
          })}
        >
          <Panel>
            <Text style={{ color: colors.cobalt }}>View subscription</Text>
          </Panel>
        </Pressable>
      ) : null}
      <HistoryPanels order={order} />
      <RefundSheet
        order={order}
        userId={userId}
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        onSuccess={(amount) => {
          setRefundOpen(false);
          setSuccess(`${formatCents(amount)} was refunded.`);
        }}
      />
    </>
  );
}

function HistoryPanels({ order }: { order: OrderDetail }) {
  if (!order.refunds.length && !order.disputes.length && !order.ledger.length) return null;
  return (
    <>
      {order.refunds.length || order.disputes.length ? (
        <Panel title="Refunds and disputes">
          {order.refunds.map((refund) => (
            <Body key={refund.id} muted={false}>
              Refund {formatCents(refund.amount_cents)} · {refund.reason ?? 'No reason supplied'} ·{' '}
              {formatDateTime(refund.created_at)}
            </Body>
          ))}
          {order.disputes.map((dispute) => (
            <Body key={dispute.id} muted={false}>
              Dispute {formatCents(dispute.amount_cents)} · {dispute.status}
            </Body>
          ))}
        </Panel>
      ) : null}
      {order.ledger.length ? (
        <Panel title="Timeline">
          {order.ledger.map((line) => (
            <View key={line.id} style={styles.moneyRow}>
              <Body muted={false}>
                {line.kind.replace(/_/g, ' ')}{'\n'}{formatDateTime(line.occurred_at)}
              </Body>
              <MoneyText cents={line.amount_cents} signed />
            </View>
          ))}
        </Panel>
      ) : null}
    </>
  );
}

function refundRemainder(order: OrderDetail): number {
  const refunded = order.refunds
    .filter((row) => row.status !== 'failed' && row.status !== 'canceled')
    .reduce((sum, row) => sum + row.amount_cents, 0);
  return Math.max(0, order.total_cents - refunded);
}

function refundPresets(order: OrderDetail, remainder: number) {
  const candidates = [
    { value: 'remaining' as const, label: `Everything remaining · ${formatCents(remainder)}`, cents: remainder },
    {
      value: 'product' as const,
      label: `Product only · ${formatCents(Math.min(order.fees.subtotal_cents, remainder))}`,
      cents: Math.min(order.fees.subtotal_cents, remainder),
    },
    {
      value: 'product_shipping' as const,
      label: `Product + shipping · ${formatCents(
        Math.min(order.fees.subtotal_cents + order.fees.shipping_charge_cents, remainder),
      )}`,
      cents: Math.min(order.fees.subtotal_cents + order.fees.shipping_charge_cents, remainder),
    },
    { value: 'custom' as const, label: 'Custom amount', cents: null },
  ];
  return candidates.filter((row, index, all) => (
    row.cents === null || all.findIndex((other) => other.cents === row.cents) === index
  ));
}

function RefundSheet({
  order,
  userId,
  open,
  onClose,
  onSuccess,
}: {
  order: OrderDetail;
  userId: string;
  open: boolean;
  onClose: () => void;
  onSuccess: (amount: number) => void;
}) {
  const remainder = refundRemainder(order);
  const presets = refundPresets(order, remainder);
  const [preset, setPreset] = React.useState<RefundPreset>('remaining');
  const [amount, setAmount] = React.useState(centsToDollarsInput(remainder));
  const [reason, setReason] = React.useState('');
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const mutation = useOfficeBillingMutation(
    userId,
    (
      variables: { amount_cents: number; reason: string },
      scope,
    ) => officeBilling.refund(order.id, variables, scope),
    { onSuccess: (_, variables) => onSuccess(variables.amount_cents) },
  );

  React.useEffect(() => {
    if (!open) return;
    setPreset('remaining');
    setAmount(centsToDollarsInput(remainder));
    setReason('');
    setAcknowledged(false);
    setLocalError(null);
    mutation.reset();
  }, [open, remainder]);

  const parsed = parseDollarsToCents(amount);
  const amountCents = parsed.ok && parsed.cents >= 1 && parsed.cents <= remainder
    ? parsed.cents
    : null;
  const choosePreset = (value: RefundPreset) => {
    setPreset(value);
    setLocalError(null);
    const selected = presets.find((row) => row.value === value);
    if (selected?.cents != null) setAmount(centsToDollarsInput(selected.cents));
  };
  const submit = () => {
    if (!parsed.ok) return setLocalError(parsed.error);
    if (parsed.cents < 1) return setLocalError('Enter an amount of at least $0.01.');
    if (parsed.cents > remainder) return setLocalError(`Enter no more than ${formatCents(remainder)}.`);
    if (!reason.trim()) return setLocalError('Enter a reason for the refund.');
    if (!acknowledged) {
      return setLocalError('Check the box to confirm you understand the refund is final.');
    }
    mutation.mutate({ amount_cents: parsed.cents, reason: reason.trim() });
  };
  const changeAmount = (value: string) => {
    setAmount(value);
    setPreset('custom');
    setLocalError(null);
  };
  const overMax = parsed.ok && parsed.cents > remainder;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Refund ${order.order_number}`}
      sub={`THINNR keeps its application fee. Up to ${formatCents(remainder)} can be returned to ${order.payer.name}.`}
      testID="refund-sheet"
      footer={
        <>
          <Button label="Cancel" onPress={onClose} />
          <Button
            label="Issue refund"
            variant="primary"
            busy={mutation.isPending}
            disabled={!acknowledged}
            onPress={submit}
            testID="button-refund-confirm"
          />
        </>
      }
    >
      <RadioGroup
        label="Refund"
        options={presets}
        value={preset}
        onChange={choosePreset}
        testIDPrefix="select-refund-preset"
      />
      <MoneyField
        label="Amount"
        value={amount}
        onChangeText={changeAmount}
        invalid={overMax || (!parsed.ok && !!amount.trim())}
        testID="input-refund-amount"
      />
      {overMax ? (
        <InlineNotice tone="bad" testID="refund-over-max">
          {`That is more than the ${formatCents(remainder)} left on this order. Enter ${formatCents(remainder)} or less.`}
        </InlineNotice>
      ) : null}
      <Field
        label="Reason"
        value={reason}
        onChangeText={setReason}
        multiline
        testID="input-refund-reason"
      />
      <Toggle
        label={`By checking this box, I understand this refund is final and cannot be undone. ${order.payer.name} will receive ${
          amountCents !== null ? formatCents(amountCents) : 'the amount above'
        } back on their original payment method, and THINNR's application fee on this order is not returned.`}
        value={acknowledged}
        onChange={setAcknowledged}
        testID="checkbox-refund-acknowledge"
      />
      {localError || mutation.error ? (
        <InlineNotice tone="bad" testID="refund-error">
          {localError ?? mutation.error!.message}
        </InlineNotice>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  moneyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 5 },
  flex: { flex: 1 },
});