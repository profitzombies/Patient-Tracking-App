/**
 * Read-only office fulfillment queue. THINNR performs every shipment; office
 * staff can inspect items, addresses and tracking, then open the transaction.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import {
  Body,
  Button,
  ChipRow,
  Empty,
  ErrorBox,
  LoadingBox,
  Panel,
  StatusPill,
  formatAddress,
} from '@/components/payments/primitives';
import { useOfficeFulfillmentInfinite } from '@/hooks/useOfficeBilling';
import { DEMO_FULFILLMENT } from '@/data/office-payments-demo';
import {
  FULFILLMENT_LABEL,
  WAREHOUSE_STATE_LABEL,
  formatDate,
  formatDateTime,
  fulfillmentTone,
  warehouseTone,
  warehouseWaitingLine,
} from '@/lib/office-billing-format';
import type { FulfillmentStatus, OrderDetail } from '@/lib/office-billing-types';
import { useColors } from '@/hooks/useColors';

const OPTIONS = (['to_ship', 'shipped', 'canceled'] as const).map((value) => ({
  value,
  label: FULFILLMENT_LABEL[value],
}));

export default function FulfillmentScreen() {
  const params = useLocalSearchParams<{ status?: FulfillmentStatus }>();
  const [stage, setStage] = React.useState<FulfillmentStatus>(params.status ?? 'to_ship');
  const demoRows = DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === stage);

  return (
    <PaymentsScreen
      section="fulfillment"
      title="Fulfillment"
      sub="Where each paid order is on its way to the patient. THINNR packs and ships every order and emails the patient tracking."
      demo={<FulfillmentView stage={stage} setStage={setStage} rows={demoRows} />}
      live={(ctx) => <LiveFulfillment ctx={ctx} stage={stage} setStage={setStage} />}
    />
  );
}

function LiveFulfillment({
  ctx,
  stage,
  setStage,
}: {
  ctx: PaymentsLive;
  stage: FulfillmentStatus;
  setStage: (value: FulfillmentStatus) => void;
}) {
  const query = useOfficeFulfillmentInfinite(ctx.userId, { status: stage });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (query.isPending) {
    return (
      <>
        <Filters stage={stage} setStage={setStage} />
        <LoadingBox label="Loading fulfillment…" testID="fulfillment-loading" />
      </>
    );
  }
  if (query.isError || !query.data) {
    return (
      <>
        <Filters stage={stage} setStage={setStage} />
        <ErrorBox error={query.error} retry={() => void query.refetch()} testID="fulfillment-error" />
      </>
    );
  }
  return (
    <FulfillmentView stage={stage} setStage={setStage} rows={rows}>
      {query.hasNextPage ? (
        <Button
          label={query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          busy={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
          testID="fulfillment-load-more"
        />
      ) : null}
    </FulfillmentView>
  );
}

function Filters({
  stage,
  setStage,
}: {
  stage: FulfillmentStatus;
  setStage: (value: FulfillmentStatus) => void;
}) {
  return (
    <ChipRow
      options={OPTIONS}
      value={stage}
      onChange={setStage}
      label="Fulfillment stage"
      testIDPrefix="filter-fulfillment"
    />
  );
}

function FulfillmentView({
  stage,
  setStage,
  rows,
  children,
}: {
  stage: FulfillmentStatus;
  setStage: (value: FulfillmentStatus) => void;
  rows: OrderDetail[];
  children?: React.ReactNode;
}) {
  const empty = stage === 'to_ship'
    ? 'Nothing waiting to ship.'
    : stage === 'shipped'
      ? 'No shipped orders yet.'
      : 'No canceled orders.';
  return (
    <>
      <Filters stage={stage} setStage={setStage} />
      <Body>THINNR handles packing and shipping. This queue is read-only for your office.</Body>
      <View testID="fulfillment-list" style={styles.list}>
        {rows.map((order) => <OrderCard key={order.id} order={order} />)}
        {!rows.length ? <Empty testID="fulfillment-empty">{empty}</Empty> : null}
        {children}
      </View>
    </>
  );
}

function OrderCard({ order }: { order: OrderDetail }) {
  const colors = useColors();
  return (
    <Panel
      title={order.order_number}
      sub={`${order.payer.name} · paid ${formatDate(order.paid_at)}`}
      action={
        <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>
          {FULFILLMENT_LABEL[order.fulfillment_status]}
        </StatusPill>
      }
    >
      <Text style={{ color: colors.text }}>Items</Text>
      {order.items.map((item) => (
        <Text key={item.id} style={{ color: colors.text }}>
          {item.product_name} × {item.quantity}
        </Text>
      ))}
      <Text style={{ color: colors.text }}>Ships to</Text>
      {formatAddress(order.shipping_address).map((line) => (
        <Text key={line} style={{ color: colors.subtleText }}>{line}</Text>
      ))}
      <FulfillmentDetail order={order} />
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`View transaction ${order.order_number}`}
        testID={`link-fulfillment-order-${order.id}`}
        onPress={() => router.push({
          pathname: '/payments/transactions/[orderId]',
          params: { orderId: order.id },
        })}
      >
        <Text style={[styles.link, { color: colors.cobalt }]}>View transaction</Text>
      </Pressable>
    </Panel>
  );
}

function FulfillmentDetail({ order }: { order: OrderDetail }) {
  if (order.fulfillment_status === 'shipped') {
    return (
      <Body>
        {formatDateTime(order.shipped_at)}{'\n'}
        {order.carrier ?? 'Carrier'} · {order.tracking_number ?? 'No tracking number'}
      </Body>
    );
  }
  if (order.fulfillment_status === 'canceled') {
    return <Body>{order.canceled_reason ?? 'No reason recorded'}</Body>;
  }
  return (
    <View style={styles.waiting}>
      <Body testID={`text-warehouse-${order.id}`}>{warehouseWaitingLine(order.warehouse)}</Body>
      {order.warehouse ? (
        <View style={styles.pillRow} testID={`pill-warehouse-${order.id}`}>
          <StatusPill tone={warehouseTone(order.warehouse.state)}>{WAREHOUSE_STATE_LABEL[order.warehouse.state]}</StatusPill>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  waiting: { gap: 6 },
  pillRow: { flexDirection: 'row' },
  link: { fontFamily: 'Inter_600SemiBold', fontSize: 12, paddingVertical: 6 },
});