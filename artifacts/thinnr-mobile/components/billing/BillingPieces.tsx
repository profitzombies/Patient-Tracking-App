/**
 * Presentational pieces for Orders and Subscriptions: a toned status badge,
 * the shipment panel, and the list cards. Rules live in
 * lib/patient-billing-core.ts; these only draw.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useColors } from '@/hooks/useColors';
import {
  cadenceLabel,
  money,
  ORDER_STATUS_LABEL,
  orderKindLabel,
  orderStatusTone,
  quantityLabel,
  shipmentPanel,
  shortDate,
  subscriptionStatus,
  type BadgeTone,
  type ShipmentPanel as ShipmentPanelModel,
} from '@/lib/patient-billing-core';
import type { PatientBillingOrder, PatientBillingSubscription, PatientShipment } from '@/lib/patient-billing-types';

export function ToneBadge({ label, tone, testID }: { label: string; tone: BadgeTone; testID?: string }) {
  const colors = useColors();
  const palette = tone === 'healthy'
    ? { bg: colors.activeBg, border: colors.activeBorder, text: colors.activeGreen }
    : tone === 'watch'
      ? { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText }
      : tone === 'risk'
        ? { bg: colors.riskBg, border: colors.riskBorder, text: colors.riskText }
        : { bg: colors.muted, border: colors.border, text: colors.labelText };
  return (
    <View testID={testID} style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

export function ShipmentPanel({ order, shipment, onTrack, testID = 'panel-shipment' }: {
  order: Pick<PatientBillingOrder, 'status'>;
  shipment: PatientShipment;
  onTrack: (url: string) => void;
  testID?: string;
}) {
  const colors = useColors();
  const panel: ShipmentPanelModel = shipmentPanel(order, shipment);
  const icon = panel.state === 'delivered' ? 'check-circle' : panel.state === 'shipped' ? 'truck' : panel.state === 'canceled' || panel.state === 'not_applicable' ? 'x-circle' : 'clock';
  return (
    <LedgerCard testID={testID} style={styles.card}>
      <View style={styles.between}>
        <View style={styles.row}>
          <Feather name={icon} size={16} color={colors.cobalt} />
          <Text style={[styles.cardTitle, { color: colors.navy }]}>Shipment</Text>
        </View>
        <ToneBadge testID={`${testID}-status`} label={panel.title} tone={panel.tone} />
      </View>
      <Text testID={`${testID}-detail`} style={[styles.body, styles.gapSm, { color: colors.bodyText }]}>{panel.detail}</Text>
      {panel.tracking ? (
        <View style={[styles.tracking, { borderTopColor: colors.border }]}>
          <Text style={[styles.hint, { color: colors.labelText }]}>{panel.tracking.carrier.toUpperCase()} TRACKING</Text>
          <Text testID={`${testID}-tracking-number`} selectable style={[styles.mono, { color: colors.navy }]}>{panel.tracking.number}</Text>
          {panel.tracking.url ? (
            <Pressable
              testID={`${testID}-track`}
              accessibilityRole="link"
              accessibilityLabel={`Track package with ${panel.tracking.carrier}`}
              onPress={() => onTrack(panel.tracking!.url!)}
              style={({ pressed }) => [styles.trackLink, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.trackText, { color: colors.cobalt }]}>Track package</Text>
              <Feather name="external-link" size={14} color={colors.cobalt} />
            </Pressable>
          ) : (
            <Text style={[styles.hint, styles.gapSm, { color: colors.subtleText }]}>Look this number up on the carrier’s site.</Text>
          )}
        </View>
      ) : null}
    </LedgerCard>
  );
}

export function OrderCard({ order, onPress }: { order: PatientBillingOrder; onPress: () => void }) {
  const colors = useColors();
  const panel = shipmentPanel(order, order.shipment);
  return (
    <LedgerCard testID={`card-order-${order.id}`} style={styles.listCard} onPress={onPress}>
      <View style={styles.cardInner}>
        <View style={styles.between}>
          <View style={styles.grow}>
            <Text style={[styles.itemTitle, { color: colors.navy }]}>{order.order_number}</Text>
            <Text style={[styles.hint, { color: colors.subtleText }]}>{shortDate(order.created_at)} · {orderKindLabel(order.kind)}</Text>
          </View>
          <ToneBadge label={ORDER_STATUS_LABEL[order.status]} tone={orderStatusTone(order.status)} />
        </View>
        <Text style={[styles.body, styles.gapSm, { color: colors.bodyText }]} numberOfLines={2}>{order.items_label}</Text>
        <View style={[styles.between, styles.gapSm]}>
          <Text style={[styles.price, { color: colors.navy }]}>{money(order.total_cents)}</Text>
          <View style={styles.row}>
            <ToneBadge testID={`card-order-${order.id}-shipment`} label={panel.title} tone={panel.tone} />
            <Feather name="chevron-right" size={18} color={colors.cobalt} />
          </View>
        </View>
        {order.refunded_cents > 0 ? <Text style={[styles.hint, { color: colors.riskText }]}>Refunded {money(order.refunded_cents)}</Text> : null}
      </View>
    </LedgerCard>
  );
}

export function SubscriptionCard({ subscription, onPress }: { subscription: PatientBillingSubscription; onPress: () => void }) {
  const colors = useColors();
  const status = subscriptionStatus(subscription);
  const perShipment = subscription.unit_price_cents * subscription.quantity + subscription.shipping_charge_cents;
  return (
    <LedgerCard testID={`card-subscription-${subscription.id}`} style={styles.listCard} onPress={onPress}>
      <View style={styles.cardInner}>
        <View style={styles.between}>
          <View style={styles.grow}>
            <Text style={[styles.itemTitle, { color: colors.navy }]}>{subscription.product_name}</Text>
            <Text style={[styles.hint, { color: colors.subtleText }]}>{cadenceLabel(subscription.cadence_weeks)} · {quantityLabel(subscription.quantity)}</Text>
          </View>
          <ToneBadge testID={`card-subscription-${subscription.id}-status`} label={status.label} tone={status.tone} />
        </View>
        <View style={[styles.between, styles.gapSm]}>
          <Text style={[styles.price, { color: colors.navy }]}>{money(perShipment)} per shipment</Text>
          <Feather name="chevron-right" size={18} color={colors.cobalt} />
        </View>
        {subscription.status !== 'canceled' && subscription.next_shipment_at ? (
          <Text style={[styles.hint, { color: colors.subtleText }]}>
            {subscription.cancel_at_period_end ? 'Last shipment' : subscription.paused ? 'Resumes for' : 'Next shipment'} {shortDate(subscription.next_shipment_at)}
          </Text>
        ) : null}
        {subscription.last_failure_message && (subscription.status === 'past_due' || subscription.status === 'unpaid') ? (
          <Text style={[styles.hint, { color: colors.riskText }]}>{subscription.last_failure_message}</Text>
        ) : null}
      </View>
    </LedgerCard>
  );
}

export function KeyValue({ label, value, testID, emphasis = false }: { label: string; value: string; testID?: string; emphasis?: boolean }) {
  const colors = useColors();
  return (
    <View style={styles.kv}>
      <Text style={[styles.body, { color: colors.bodyText }]}>{label}</Text>
      <Text testID={testID} style={[emphasis ? styles.price : styles.body, { color: colors.navy }]}>{value}</Text>
    </View>
  );
}

export const billingStyles = StyleSheet.create({
  card: { padding: 14, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontFamily: 'PlayfairDisplay_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  hint: { fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  gap: { marginTop: 14 },
  gapSm: { marginTop: 9 },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 9 },
  buttonGrow: { flex: 1 },
  empty: { fontSize: 13, padding: 14, textAlign: 'center', fontFamily: 'Inter_500Medium' },
  panel: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  panelTitle: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});

const styles = StyleSheet.create({
  card: { padding: 14, marginBottom: 10 },
  listCard: { marginBottom: 10 },
  cardInner: { padding: 14 },
  cardTitle: { fontSize: 16, fontFamily: 'PlayfairDisplay_700Bold' },
  itemTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  price: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  hint: { fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  mono: { fontSize: 13, marginTop: 3, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.4 },
  badge: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 0.3 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  grow: { flex: 1 },
  gapSm: { marginTop: 9 },
  tracking: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  trackLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9, minHeight: 44 },
  trackText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 3 },
});
