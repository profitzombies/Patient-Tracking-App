import React, { useCallback, useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { GhostButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { BillingScreen, SectionLabel } from '@/components/billing/BillingScreen';
import { KeyValue, ShipmentPanel, ToneBadge } from '@/components/billing/BillingPieces';
import { openExternal } from '@/components/billing/actions';
import { useBillingNotice } from '@/components/billing/useBillingNotice';
import { useBillingResource } from '@/components/billing/useBillingResource';
import { useColors } from '@/hooks/useColors';
import { getOrder, getOrderReceipt } from '@/lib/patient-billing-api';
import {
  addressLines,
  arrivalWindow,
  errorMessage,
  money,
  ORDER_STATUS_LABEL,
  orderKindLabel,
  orderStatusTone,
  shippingChoiceLabel,
  shortDate,
  shortDateTime,
  subscriptionHref,
} from '@/lib/patient-billing-core';
import type { PatientOrderDetail, PatientReceipt } from '@/lib/patient-billing-types';

export default function OrderDetailScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] ?? '' : params.id ?? '';
  const load = useCallback(() => getOrder(id), [id]);
  const order = useBillingResource<PatientOrderDetail>(load, 'order');
  const notice = useBillingNotice();
  const [busy, setBusy] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PatientReceipt | null>(null);
  const row = order.data;

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    order.setError(null);
    try {
      await work();
    } catch (caught) {
      order.setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const openReceipt = (pdf = false) => {
    if (!row) return;
    void run(pdf ? 'receipt-pdf' : 'receipt', async () => {
      const result = receipt ?? await getOrderReceipt(row.id);
      setReceipt(result);
      const url = pdf ? result.invoice_pdf_url : result.receipt_url ?? result.invoice_url;
      if (!url) throw new Error(pdf ? 'A PDF is not available for this order.' : 'A receipt is not available for this order.');
      await openExternal(url);
    });
  };

  const track = (url: string) => {
    void run('track', () => openExternal(url));
  };

  const refresh = async () => {
    const failure = await order.refresh();
    if (failure) notice.announce(`Couldn't refresh this order. ${failure}`);
    else AccessibilityInfo.announceForAccessibility('Order updated');
  };

  return (
    <BillingScreen
      title={row ? `Order ${row.order_number}` : 'Order'}
      testID="screen-order"
      loading={order.loading}
      error={order.error}
      onRetry={() => void order.reload()}
      hasContent={row !== null}
      notice={notice.notice}
      onDismissNotice={notice.dismiss}
      onRefresh={() => void refresh()}
      refreshing={order.refreshing}
      refreshLabel="Refresh order"
    >
      {row ? (
        <>
          <LedgerCard testID="card-order-summary" style={styles.card}>
            <View style={styles.between}>
              <View style={styles.grow}>
                <Text style={[styles.cardTitle, { color: colors.navy }]}>{orderKindLabel(row.kind)}</Text>
                <Text style={[styles.hint, { color: colors.subtleText }]}>Placed {shortDateTime(row.created_at)}</Text>
                {row.paid_at ? <Text style={[styles.hint, { color: colors.subtleText }]}>Paid {shortDateTime(row.paid_at)}</Text> : null}
              </View>
              <ToneBadge testID="badge-order-status" label={ORDER_STATUS_LABEL[row.status]} tone={orderStatusTone(row.status)} />
            </View>
            {row.failure_message ? <Text testID="text-order-failure" style={[styles.body, styles.gapSm, { color: colors.riskText }]}>{row.failure_message}</Text> : null}
            {row.subscription_id ? (
              <GhostButton
                testID="button-order-subscription"
                label="View subscription"
                accessibilityLabel="View the subscription this delivery belongs to"
                onPress={() => router.push(subscriptionHref(row.subscription_id!) as never)}
                style={styles.gapSm}
              />
            ) : null}
          </LedgerCard>

          <SectionLabel text="Shipment" />
          <ShipmentPanel order={row} shipment={row.shipment} onTrack={track} />
          <LedgerCard testID="card-order-shipping-method" style={styles.card}>
            <Text style={[styles.label, { color: colors.labelText }]}>SHIPPING METHOD</Text>
            <Text testID="text-order-shipping-method" style={[styles.body, { color: colors.bodyText }]}>{shippingChoiceLabel(row.shipping)}</Text>
            {row.shipping.source === 'live' && arrivalWindow(row.shipping.delivery_window_start, row.shipping.delivery_window_end) ? (
              <Text testID="text-order-arrival" style={[styles.hint, { color: colors.subtleText }]}>
                {arrivalWindow(row.shipping.delivery_window_start, row.shipping.delivery_window_end)}
              </Text>
            ) : null}
          </LedgerCard>
          <LedgerCard testID="card-order-address" style={styles.card}>
            <Text style={[styles.label, { color: colors.labelText }]}>SHIPS TO</Text>
            {addressLines(row.shipping_address).map((line, index) => (
              <Text key={`${index}-${line}`} style={[styles.body, { color: colors.bodyText }]}>{line}</Text>
            ))}
          </LedgerCard>

          <SectionLabel text="Items" />
          <LedgerCard testID="card-order-items" style={styles.card}>
            {row.items.map((item, index) => (
              <View key={`${item.product_id}-${index}`} style={[styles.item, index > 0 && { borderTopColor: colors.border, borderTopWidth: 1 }]}>
                <View style={styles.grow}>
                  <Text style={[styles.itemTitle, { color: colors.navy }]}>{item.name}</Text>
                  <Text style={[styles.hint, { color: colors.subtleText }]}>{item.quantity} × {money(item.unit_price_cents)}</Text>
                </View>
                <Text style={[styles.price, { color: colors.navy }]}>{money(item.line_total_cents)}</Text>
              </View>
            ))}
            <View style={[styles.totals, { borderTopColor: colors.border }]}>
              <KeyValue label="Subtotal" value={money(row.subtotal_cents)} />
              <KeyValue label="Shipping" value={money(row.shipping_charge_cents)} />
              {row.tax_cents > 0 ? <KeyValue label="Tax" value={money(row.tax_cents)} /> : null}
              <KeyValue label="Total" value={money(row.total_cents)} testID="text-order-total" emphasis />
              {row.refunded_cents > 0 ? <KeyValue label="Refunded" value={`-${money(row.refunded_cents)}`} testID="text-order-refunded" /> : null}
            </View>
          </LedgerCard>

          {row.refunds.length ? (
            <>
              <SectionLabel text="Refunds" />
              <LedgerCard testID="card-order-refunds" style={styles.card}>
                {row.refunds.map((refund, index) => (
                  <KeyValue key={`${refund.created_at}-${index}`} label={`${shortDate(refund.created_at)} · ${refund.status}`} value={money(refund.amount_cents)} />
                ))}
              </LedgerCard>
            </>
          ) : null}

          {row.receipt_available ? (
            <>
              <SectionLabel text="Receipt" />
              <View style={styles.buttonRow}>
                <GhostButton
                  testID="button-order-receipt"
                  label={busy === 'receipt' ? 'Opening…' : 'Open receipt'}
                  accessibilityLabel={`Open receipt for order ${row.order_number}`}
                  disabled={busy !== null}
                  onPress={() => openReceipt(false)}
                  style={styles.buttonGrow}
                />
                {receipt?.invoice_pdf_url ? (
                  <GhostButton
                    testID="button-order-receipt-pdf"
                    label={busy === 'receipt-pdf' ? 'Opening…' : 'PDF'}
                    accessibilityLabel={`Open invoice PDF for order ${row.order_number}`}
                    disabled={busy !== null}
                    onPress={() => openReceipt(true)}
                    style={styles.buttonGrow}
                  />
                ) : null}
              </View>
            </>
          ) : null}
        </>
      ) : null}
    </BillingScreen>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontFamily: 'PlayfairDisplay_700Bold' },
  label: { fontSize: 10, letterSpacing: 1.2, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  itemTitle: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  price: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  hint: { fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  grow: { flex: 1 },
  gapSm: { marginTop: 9 },
  item: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 8 },
  totals: { borderTopWidth: 1, marginTop: 6, paddingTop: 8 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonGrow: { flex: 1 },
});
