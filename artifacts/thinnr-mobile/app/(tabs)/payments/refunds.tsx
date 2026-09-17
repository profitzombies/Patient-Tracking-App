/**
 * Read-only refund and dispute ledger. Kind filters are applied
 * locally in demo and sent with the device-local range for signed-in staff.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import {
  ChipRow,
  Empty,
  ErrorBox,
  LoadingBox,
  MoneyText,
  Panel,
  StatusPill,
} from '@/components/payments/primitives';
import { RangePicker, usePaymentsRange } from '@/components/payments/range';
import { useOfficeRefunds } from '@/hooks/useOfficeBilling';
import { DEMO_REFUNDS } from '@/data/office-payments-demo';
import { formatDate, formatDateTime, type PillTone } from '@/lib/office-billing-format';
import type { OfficeRefundRow } from '@/lib/office-billing-types';
import { useColors } from '@/hooks/useColors';

const KIND_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'refund', label: 'Refunds' },
  { value: 'dispute', label: 'Disputes' },
] as const;
const STATUS_LABEL: Record<string, string> = {
  succeeded: 'Refunded',
  pending: 'Refund pending',
  failed: 'Refund failed',
  canceled: 'Refund canceled',
  needs_response: 'Needs response',
  warning_needs_response: 'Needs response',
  under_review: 'Under review',
  warning_under_review: 'Under review',
  won: 'Dispute won',
  lost: 'Dispute lost',
  charge_refunded: 'Refunded',
  warning_closed: 'Closed',
};

interface Controls {
  kind: string;
  setKind: (value: string) => void;
}

export default function RefundsScreen() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const initialKind = params.kind === 'refund' || params.kind === 'dispute' ? params.kind : '';
  const [kind, setKind] = React.useState(initialKind);
  const controls = { kind, setKind };
  const demoRows = DEMO_REFUNDS.filter((row) => !kind || row.kind === kind);

  return (
    <PaymentsScreen
      section="refunds"
      title="Refunds and disputes"
      sub="Money returned to patients and card disputes on your orders. To issue a refund, open the transaction and choose Refund."
      demo={<RefundsView {...controls} rows={demoRows} />}
      live={(ctx) => <LiveRefunds ctx={ctx} {...controls} />}
    />
  );
}

function LiveRefunds({ ctx, ...controls }: { ctx: PaymentsLive } & Controls) {
  const { range } = usePaymentsRange();
  const query = useOfficeRefunds(ctx.userId, {
    kind: controls.kind || undefined,
    from: range.from,
    to: range.to,
  });

  return (
    <>
      <RangePicker testIDPrefix="refunds-range" />
      {query.isPending ? (
        <LoadingBox label="Loading refunds…" testID="refunds-loading" />
      ) : query.isError || !query.data ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} testID="refunds-error" />
      ) : (
        <RefundsView
          {...controls}
          rows={query.data.items}
        />
      )}
    </>
  );
}

function RefundsView({
  rows,
  ...controls
}: Controls & { rows: OfficeRefundRow[] }) {
  return (
    <>
      <ChipRow
        options={KIND_OPTIONS}
        value={controls.kind}
        onChange={controls.setKind}
        label="Show"
        testIDPrefix="filter-refunds"
      />
      <Panel title="Refunds and disputes">
        {!rows.length ? (
          <Empty testID="refunds-empty">No refunds or disputes in this range.</Empty>
        ) : (
          rows.map((row) => <RefundRow key={row.id} row={row} />)
        )}
      </Panel>
    </>
  );
}

function refundTone(row: OfficeRefundRow): PillTone {
  if (row.kind === 'refund') {
    if (row.status === 'failed') return 'bad';
    if (row.status === 'succeeded') return 'neutral';
    return 'warn';
  }
  if (row.status === 'won') return 'good';
  if (row.status === 'lost') return 'bad';
  return 'warn';
}

function humanReason(value: string | null): string {
  if (!value) return '—';
  return value.includes('_')
    ? value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())
    : value;
}

function RefundRow({ row }: { row: OfficeRefundRow }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open order ${row.order_number} (${row.kind})`}
      testID={`row-refund-${row.id}`}
      onPress={() => router.push({
        pathname: '/payments/transactions/[orderId]',
        params: { orderId: row.order_id },
      })}
      style={[styles.row, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}
    >
      <View style={styles.head}>
        <Text style={[styles.title, { color: colors.navy }]}>
          {row.kind === 'refund' ? 'Refund' : 'Dispute'} · {row.order_number}
        </Text>
        <MoneyText cents={-row.amount_cents} signed />
      </View>
      <Text style={{ color: colors.text }}>{row.payer_name ?? '—'}</Text>
      <Text style={{ color: colors.subtleText }}>
        {humanReason(row.reason)} · {formatDateTime(row.created_at)}
      </Text>
      <StatusPill tone={refundTone(row)}>
        {STATUS_LABEL[row.status] ?? row.status.replace(/_/g, ' ')}
      </StatusPill>
      {row.kind === 'dispute' && row.evidence_due_by && !row.closed_at ? (
        <Text style={{ color: colors.subtleText }}>Response due {formatDate(row.evidence_due_by)}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 6 },
  head: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  title: { fontFamily: 'Inter_700Bold' },
});