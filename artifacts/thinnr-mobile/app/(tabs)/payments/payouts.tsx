/**
 * Stripe balance and payout history for the signed-in office.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import {
  Body,
  Empty,
  ErrorBox,
  LoadingBox,
  MetricTile,
  MoneyText,
  Panel,
  StatusPill,
} from '@/components/payments/primitives';
import { useOfficePayouts } from '@/hooks/useOfficeBilling';
import { formatCents, formatDate, type PillTone } from '@/lib/office-billing-format';
import type { OfficePayoutsResponse, PayoutRow } from '@/lib/office-billing-types';
import { useColors } from '@/hooks/useColors';

export default function PayoutsScreen() {
  return (
    <PaymentsScreen
      section="payouts"
      title="Payouts"
      sub="Money Stripe has sent or is preparing for your bank."
      live={(ctx) => <LivePayouts ctx={ctx} />}
    />
  );
}

function LivePayouts({ ctx }: { ctx: PaymentsLive }) {
  const query = useOfficePayouts(ctx.userId);

  if (query.isPending) return <LoadingBox label="Loading payouts…" testID="payouts-loading" />;
  if (query.isError || !query.data) {
    return <ErrorBox error={query.error} retry={() => void query.refetch()} testID="payouts-error" />;
  }
  return <PayoutsView data={query.data} />;
}

function PayoutsView({ data }: { data: OfficePayoutsResponse }) {
  return (
    <>
      <View style={styles.tiles}>
        <MetricTile
          label="Available balance"
          value={formatCents(data.balance.available_cents)}
          testID="payouts-available"
        />
        <MetricTile
          label="Pending balance"
          value={formatCents(data.balance.pending_cents)}
          testID="payouts-pending"
        />
      </View>
      <Panel title="Payout schedule">
        <Body testID="payouts-schedule">Managed by Stripe</Body>
      </Panel>
      <Panel title="Payout history">
        {data.items.map((row) => <Payout key={row.id} row={row} />)}
        {!data.items.length ? <Empty testID="payouts-empty">No payout history yet.</Empty> : null}
      </Panel>
    </>
  );
}

function payoutTone(status: string): PillTone {
  if (status === 'paid') return 'good';
  if (status === 'failed' || status === 'canceled') return 'bad';
  if (status === 'pending' || status === 'in_transit') return 'warn';
  return 'neutral';
}

function Payout({ row }: { row: PayoutRow }) {
  const colors = useColors();
  return (
    <View
      testID={`row-payout-${row.id}`}
      style={[styles.row, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}
    >
      <View style={styles.head}>
        <MoneyText cents={row.amount_cents} />
        <StatusPill tone={payoutTone(row.status)}>{row.status.replace(/_/g, ' ')}</StatusPill>
      </View>
      <Body>Arrival {formatDate(row.arrival_date)}</Body>
      <Body>Method {row.method ?? '—'}</Body>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  row: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 5 },
  head: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
});