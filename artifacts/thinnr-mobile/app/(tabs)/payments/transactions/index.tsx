/**
 * Office transaction list with status, search and cursor paging.
 * Demo rows filter locally; live filters are sent to the office billing API.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { Field } from '@/components/payments/dialogs';
import {
  Button,
  ChipRow,
  Empty,
  ErrorBox,
  LoadingBox,
  MoneyText,
  Panel,
  StatusPill,
} from '@/components/payments/primitives';
import { RangePicker, usePaymentsRange } from '@/components/payments/range';
import { useOfficeOrdersInfinite } from '@/hooks/useOfficeBilling';
import { DEMO_ORDERS } from '@/data/office-payments-demo';
import {
  FULFILLMENT_LABEL,
  ORDER_KIND_LABEL,
  ORDER_STATUS_LABEL,
  fulfillmentTone,
  orderStatusTone,
} from '@/lib/office-billing-format';
import type { OrderSummary } from '@/lib/office-billing-types';
import { useColors } from '@/hooks/useColors';

const STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Pending' },
  { value: 'refunded', label: 'Refunded' },
] as const;
const PAGE_SIZE = 50;

interface Controls {
  status: string;
  setStatus: (value: string) => void;
  q: string;
  setQ: (value: string) => void;
}

export default function TransactionsScreen() {
  const params = useLocalSearchParams<{ status?: string }>();
  const [status, setStatusState] = React.useState(params.status ?? '');
  const [q, setQState] = React.useState('');
  const controls: Controls = {
    status,
    setStatus: setStatusState,
    q,
    setQ: setQState,
  };
  const normalized = q.toLowerCase();
  const demoRows = DEMO_ORDERS.filter((row) => (
    (!status || row.status === status)
    && (!q || `${row.order_number} ${row.payer.name}`.toLowerCase().includes(normalized))
  ));

  return (
    <PaymentsScreen
      section="transactions"
      title="Transactions"
      sub="Orders and refunds for your office."
      refresh="transactions"
      demo={<TransactionsView {...controls} rows={demoRows} />}
      live={(ctx) => <LiveTransactions ctx={ctx} {...controls} />}
    />
  );
}

function LiveTransactions({ ctx, ...controls }: { ctx: PaymentsLive } & Controls) {
  const { range } = usePaymentsRange();
  const query = useOfficeOrdersInfinite(ctx.userId, {
    status: controls.status || undefined,
    q: controls.q || undefined,
    from: range.from,
    to: range.to,
    limit: PAGE_SIZE,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isPending) {
    return (
      <>
        <RangePicker testIDPrefix="transactions-range" />
        <Filters {...controls} />
        <LoadingBox label="Loading transactions…" testID="transactions-loading" />
      </>
    );
  }
  // A failed re-read keeps the loaded pages on screen (the shell shows a notice).
  if (!query.data) {
    return (
      <>
        <RangePicker testIDPrefix="transactions-range" />
        <Filters {...controls} />
        <ErrorBox error={query.error} retry={() => void query.refetch()} testID="transactions-error" />
      </>
    );
  }
  return (
    <>
      <RangePicker testIDPrefix="transactions-range" />
      <TransactionsView {...controls} rows={rows}>
        {query.hasNextPage ? (
          <Button
            label={query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            busy={query.isFetchingNextPage}
            onPress={() => void query.fetchNextPage()}
            testID="transactions-load-more"
          />
        ) : null}
      </TransactionsView>
    </>
  );
}

function Filters(controls: Controls) {
  return (
    <Panel title="Filters">
      <Field
        label="Search"
        placeholder="Search"
        value={controls.q}
        onChangeText={controls.setQ}
        testID="input-transactions-search"
      />
      <ChipRow
        options={STATUSES}
        value={controls.status}
        onChange={controls.setStatus}
        label="Status"
        testIDPrefix="filter-transactions-status"
      />
    </Panel>
  );
}

function TransactionsView({
  rows,
  children,
  ...controls
}: Controls & { rows: OrderSummary[]; children?: React.ReactNode }) {
  return (
    <>
      <Filters {...controls} />
      <Panel title="Transactions">
        {!rows.length ? (
          <Empty testID="transactions-empty">No transactions match these filters.</Empty>
        ) : (
          rows.map((row) => <OrderRow key={row.id} row={row} />)
        )}
        {children}
      </Panel>
    </>
  );
}

function OrderRow({ row }: { row: OrderSummary }) {
  const colors = useColors();
  return (
    <Pressable
      testID={`row-order-${row.id}`}
      accessibilityRole="link"
      accessibilityLabel={`Open order ${row.order_number}`}
      onPress={() => router.push({
        pathname: '/payments/transactions/[orderId]',
        params: { orderId: row.id },
      })}
      style={[styles.row, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}
    >
      <View style={styles.head}>
        <Text style={[styles.order, { color: colors.navy }]}>{row.order_number}</Text>
        <MoneyText cents={row.total_cents} />
      </View>
      <Text style={{ color: colors.text }}>{row.payer.name}</Text>
      <Text style={{ color: colors.subtleText }}>{ORDER_KIND_LABEL[row.kind]} · {row.items_label}</Text>
      <View style={styles.pills}>
        <StatusPill tone={orderStatusTone(row.status)}>{ORDER_STATUS_LABEL[row.status]}</StatusPill>
        <StatusPill tone={fulfillmentTone(row.fulfillment_status)}>
          {FULFILLMENT_LABEL[row.fulfillment_status]}
        </StatusPill>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 5 },
  head: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  order: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});