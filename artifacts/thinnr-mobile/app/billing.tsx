import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import {
  ErrorBox,
  FieldLabel,
  GhostButton,
  PrimaryButton,
} from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { TODAY } from '@/data/patient-data';
import { useColors } from '@/hooks/useColors';
import {
  cancelSubscription,
  createCheckoutLink,
  getBillingOverview,
  getOrderReceipt,
  skipNextShipment,
} from '@/lib/patient-billing-api';
import type {
  PatientBillingOrder,
  PatientBillingOverview,
  PatientReceipt,
  PatientBillingSubscription,
  PublicLinkProduct,
} from '@/lib/patient-billing-types';

const demoRenewal = new Date(TODAY);
demoRenewal.setUTCMonth(demoRenewal.getUTCMonth() + 1);

const DEMO_OVERVIEW: PatientBillingOverview = {
  office: { provider_id: 'demo', office_name: 'Jenkins Wellness', payments_available: true },
  shipping_charge_cents: 1000,
  products: [
    { product_id: 'demo-control', name: 'Control', description: 'Daily metabolic support.', image_url: null, unit_price_cents: 6999, office_priced: true, subscription_available: true, subscription_cadences_weeks: [4, 8], default_cadence_weeks: 4, subscribe_save_percent: 10, subscription_unit_price_cents: 6299 },
    { product_id: 'demo-hydrate', name: 'Hydrate', description: 'Electrolyte drink mix.', image_url: null, unit_price_cents: 3499, office_priced: true, subscription_available: true, subscription_cadences_weeks: [4, 8], default_cadence_weeks: 4, subscribe_save_percent: 10, subscription_unit_price_cents: 3149 },
    { product_id: 'demo-protein', name: 'Protein', description: 'Vanilla protein blend.', image_url: null, unit_price_cents: 4499, office_priced: true, subscription_available: false, subscription_cadences_weeks: [], default_cadence_weeks: 4, subscribe_save_percent: 0, subscription_unit_price_cents: null },
  ],
  orders: [
    { id: 'demo-order-1', order_number: 'TH-D3MO01', kind: 'one_time', status: 'paid', fulfillment_status: 'shipped', total_cents: 5499, refunded_cents: 0, item_count: 1, items_label: 'Protein', created_at: '2026-08-18T14:00:00.000Z', paid_at: '2026-08-18T14:01:00.000Z', receipt_available: true, shipment: { status: 'shipped', carrier: 'USPS', tracking_number: '9400111899223197428490', tracking_url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490', shipped_at: '2026-08-19T16:00:00.000Z', delivered_at: null, canceled_at: null, updated_at: '2026-08-19T16:00:00.000Z' }, subscription_id: null, cart_id: null },
    { id: 'demo-order-2', order_number: 'TH-D3MO02', kind: 'subscription_renewal', status: 'paid', fulfillment_status: 'to_ship', total_cents: 7999, refunded_cents: 0, item_count: 1, items_label: 'Control monthly renewal', created_at: '2026-08-22T09:00:00.000Z', paid_at: '2026-08-22T09:01:00.000Z', receipt_available: true, shipment: { status: 'processing', carrier: null, tracking_number: null, tracking_url: null, shipped_at: null, delivered_at: null, canceled_at: null, updated_at: '2026-08-22T09:01:00.000Z' }, subscription_id: 'demo-sub-1', cart_id: null },
  ],
  subscriptions: [
    { id: 'demo-sub-1', product_name: 'Control', unit_price_cents: 6999, shipping_charge_cents: 1000, status: 'active', paused: false, current_period_end: demoRenewal.toISOString(), cancel_at_period_end: false, last_hosted_invoice_url: null, last_failure_message: null, product_id: 'demo-control', cadence_weeks: 4, quantity: 1, next_shipment_at: demoRenewal.toISOString(), shipping_address: { name: 'Demo Patient', line1: '100 Wellness Way', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', phone: null } },
  ],
};

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function date(value: string | null): string {
  if (!value) return 'Not available';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : 'That didn’t go through. Please try again.';
}

async function openExternal(url: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await WebBrowser.openBrowserAsync(url);
    return;
  }
  const opened = typeof window !== 'undefined' ? window.open(url, '_blank', 'noopener') : null;
  if (!opened) await Linking.openURL(url);
}

function demoNudge(): void {
  const title = 'Demo mode';
  const message = 'Sign in with a patient account to manage payments.';
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

const orderStatus: Record<PatientBillingOrder['status'], string> = {
  paid: 'Paid',
  pending: 'Pending',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
  failed: 'Failed',
  canceled: 'Canceled',
  disputed: 'Disputed',
};

export default function BillingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { account } = usePatientAccount();
  const demo = account.kind === 'demo';
  const [overview, setOverview] = useState<PatientBillingOverview | null>(demo ? DEMO_OVERVIEW : null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, PatientReceipt>>({});
  const mounted = useRef(true);
  const overviewSource = useRef<'demo' | 'real' | null>(null);
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const load = useCallback(async () => {
    if (account.kind !== 'real') return;
    setLoading(true);
    setError(null);
    try {
      const result = await getBillingOverview();
      if (mounted.current) { overviewSource.current = 'real'; setOverview(result); }
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [account.kind]);

  useEffect(() => {
    mounted.current = true;
    if (account.kind === 'real') {
      setOverview(null);
      void load();
    } else if (account.kind === 'demo') {
      overviewSource.current = 'demo';
      setOverview(DEMO_OVERVIEW);
      setLoading(false);
      setError(null);
    }
    return () => { mounted.current = false; };
  }, [account.kind, load]);

  useEffect(() => {
    if (account.kind !== 'real') return;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void load();
    });
    return () => listener.remove();
  }, [account.kind, load]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const checkout = (productId?: string) => {
    if (demo) return demoNudge();
    void run(`checkout:${productId ?? 'all'}`, async () => {
      const link = await createCheckoutLink(productId ? { product_id: productId } : {});
      await openExternal(link.url);
      await load();
    });
  };

  const receipt = (orderId: string, pdf = false) => {
    if (demo) return demoNudge();
    void run(`receipt:${orderId}:${pdf ? 'pdf' : 'page'}`, async () => {
      const result = await getOrderReceipt(orderId);
      setReceipts(current => ({ ...current, [orderId]: result }));
      const url = pdf ? result.invoice_pdf_url : result.receipt_url ?? result.invoice_url;
      if (!url) throw new Error(pdf ? 'A PDF is not available for this order.' : 'A receipt is not available for this order.');
      await openExternal(url);
    });
  };

  const replaceSubscription = (updated: PatientBillingSubscription) => setOverview(current => current ? {
    ...current,
    subscriptions: current.subscriptions.map(row => row.id === updated.id ? updated : row),
  } : current);

  const confirmSkip = (subscription: PatientBillingSubscription) => {
    if (demo) return demoNudge();
    const proceed = () => void run(`skip:${subscription.id}`, async () => replaceSubscription(await skipNextShipment(subscription.id)));
    const question = `Skip the ${subscription.product_name} shipment on ${date(subscription.next_shipment_at)}?`;
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(question)) proceed();
    } else {
      Alert.alert('Skip this shipment?', `${question} Your following shipment stays on schedule.`, [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Skip shipment', onPress: proceed },
      ]);
    }
  };

  // Email deep links: /billing?subscription=<id> focuses that plan and
  // ?action=skip opens the skip confirmation once the live overview is in.
  const deepLink = useLocalSearchParams<{ subscription?: string | string[]; action?: string | string[] }>();
  const linkedSubscriptionId = Array.isArray(deepLink.subscription) ? deepLink.subscription[0] : deepLink.subscription;
  const linkedAction = Array.isArray(deepLink.action) ? deepLink.action[0] : deepLink.action;
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    // Wait for the live overview: right after sign-in the demo dataset is still
    // in state for one commit and would make a valid link look stale.
    if (!overview || overviewSource.current !== 'real' || !linkedSubscriptionId || linkedAction !== 'skip' || account.kind !== 'real') return;
    const key = `${linkedSubscriptionId}:${linkedAction}`;
    if (handledLink.current === key) return;
    handledLink.current = key;
    const target = overview.subscriptions.find(row => row.id === linkedSubscriptionId);
    if (target && canSkip(target)) confirmSkip(target);
    else setError('That shipment can no longer be skipped from this link. Manage the plan below.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, linkedSubscriptionId, linkedAction, account.kind]);

  const confirmCancel = (subscription: PatientBillingSubscription) => {
    if (demo) return demoNudge();
    const proceed = () => void run(`cancel:${subscription.id}`, async () => {
      const updated = await cancelSubscription(subscription.id);
      setOverview(current => current ? {
        ...current,
        subscriptions: current.subscriptions.map(row => row.id === updated.id ? updated : row),
      } : current);
    });
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm('Cancel this subscription at renewal?')) proceed();
    } else {
      Alert.alert('Cancel at renewal?', 'You will keep access through the current billing period.', [
        { text: 'Keep subscription', style: 'cancel' },
        { text: 'Cancel at renewal', style: 'destructive', onPress: proceed },
      ]);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable testID="billing-back" accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={10}>
          <Feather name="chevron-left" size={22} color={colors.navy} />
        </Pressable>
        <Text style={[styles.title, { color: colors.navy }]}>Payments & orders</Text>
        <View style={styles.spacer} />
      </View>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 28) }]}
        bottomOffset={72}
      >
        {error ? (
          <View>
            <ErrorBox testID="text-billing-error" message={error} />
            {!overview ? <PrimaryButton testID="button-billing-retry" label="Retry" onPress={() => void load()} style={styles.smallGap} /> : null}
          </View>
        ) : null}
        {loading && !overview ? <Text style={[styles.body, { color: colors.bodyText }]}>Loading payments…</Text> : null}
        {overview ? (
          <>
            <Text style={[styles.section, { color: colors.labelText }]}>OFFICE</Text>
            <OfficeCard overview={overview} busy={busy} onCheckout={checkout} />
            <Text style={[styles.section, { color: colors.labelText }]}>ORDERS</Text>
            <View testID="list-orders">
              {overview.orders.length ? overview.orders.map(order => (
                <OrderCard
                  key={order.id}
                  order={order}
                  busy={busy}
                  pdfAvailable={receipts[order.id]?.invoice_pdf_url != null}
                  onReceipt={receipt}
                />
              )) : <Text style={[styles.empty, { color: colors.subtleText }]}>No orders yet.</Text>}
            </View>
            <Text style={[styles.section, { color: colors.labelText }]}>SUBSCRIPTIONS</Text>
            <View testID="list-subscriptions">
              {overview.subscriptions.length ? overview.subscriptions.map(subscription => (
                <SubscriptionCard
                  key={subscription.id}
                  subscription={subscription}
                  busy={busy}
                  focused={subscription.id === linkedSubscriptionId}
                  onSkip={confirmSkip}
                  onCancel={confirmCancel}
                  onOpen={url => demo ? demoNudge() : void openExternal(url).catch(caught => setError(errorMessage(caught)))}
                />
              )) : <Text style={[styles.empty, { color: colors.subtleText }]}>No subscriptions.</Text>}
            </View>
          </>
        ) : null}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function OfficeCard({ overview, busy, onCheckout }: {
  overview: PatientBillingOverview;
  busy: string | null;
  onCheckout: (productId?: string) => void;
}) {
  const colors = useColors();
  const office = overview.office;
  return (
    <LedgerCard testID="card-office" style={styles.card}>
      <Text style={[styles.cardTitle, { color: colors.navy }]}>{office?.office_name ?? 'Your office'}</Text>
      {!office?.payments_available ? (
        <Text style={[styles.body, styles.smallGap, { color: colors.bodyText }]}>Your office isn’t taking payments in the app yet.</Text>
      ) : (
        <>
          {overview.products.map(product => (
            <ProductRow key={product.product_id} product={product} busy={busy} onOrder={() => onCheckout(product.product_id)} />
          ))}
          <PrimaryButton
            testID="button-open-checkout"
            label={busy === 'checkout:all' ? 'Opening…' : 'Open checkout'}
            accessibilityLabel="Open office checkout"
            disabled={busy !== null}
            onPress={() => onCheckout()}
            style={styles.gap}
          />
        </>
      )}
    </LedgerCard>
  );
}

function ProductRow({ product, busy, onOrder }: { product: PublicLinkProduct; busy: string | null; onOrder: () => void }) {
  const colors = useColors();
  const key = `checkout:${product.product_id}`;
  return (
    <View style={[styles.item, { borderTopColor: colors.border }]}>
      {product.image_url ? <Image source={{ uri: product.image_url }} accessibilityLabel={product.name} style={styles.productImage} /> : null}
      <View style={styles.itemMain}>
        <View style={styles.wrapRow}>
          <Text style={[styles.itemTitle, { color: colors.navy }]}>{product.name}</Text>
          {product.subscription_available ? <Text style={[styles.badge, { color: colors.cobalt, backgroundColor: colors.activeBg }]}>Monthly available</Text> : null}
        </View>
        <Text style={[styles.body, { color: colors.bodyText }]}>{product.description}</Text>
        <Text style={[styles.price, { color: colors.navy }]}>{money(product.unit_price_cents)}</Text>
        <GhostButton
          testID={`button-order-${product.product_id}`}
          label={busy === key ? 'Opening…' : 'Order'}
          accessibilityLabel={`Order ${product.name}`}
          disabled={busy !== null}
          onPress={onOrder}
          style={styles.smallGap}
        />
      </View>
    </View>
  );
}

function OrderCard({ order, busy, pdfAvailable, onReceipt }: {
  order: PatientBillingOrder;
  busy: string | null;
  pdfAvailable: boolean;
  onReceipt: (id: string, pdf?: boolean) => void;
}) {
  const colors = useColors();
  return (
    <LedgerCard style={styles.listCard}>
      <View style={styles.between}>
        <View>
          <Text style={[styles.itemTitle, { color: colors.navy }]}>{order.order_number}</Text>
          <Text style={[styles.hint, { color: colors.subtleText }]}>{date(order.created_at)}</Text>
        </View>
        <Text style={[styles.badge, { color: colors.cobalt, backgroundColor: colors.activeBg }]}>{orderStatus[order.status]}</Text>
      </View>
      <Text style={[styles.body, styles.smallGap, { color: colors.bodyText }]}>{order.items_label}</Text>
      <Text style={[styles.price, { color: colors.navy }]}>{money(order.total_cents)}</Text>
      {order.status === 'paid' ? <Text style={[styles.hint, { color: colors.subtleText }]}>{order.fulfillment_status === 'shipped' ? 'Shipped' : 'To ship'}</Text> : null}
      {order.refunded_cents > 0 ? <Text style={[styles.body, { color: colors.riskText }]}>Refunded {money(order.refunded_cents)}</Text> : null}
      {order.receipt_available ? (
        <View style={styles.buttonRow}>
          <GhostButton testID={`button-receipt-${order.id}`} label={busy?.startsWith(`receipt:${order.id}`) ? 'Opening…' : 'Receipt'} accessibilityLabel={`Open receipt for order ${order.order_number}`} disabled={busy !== null} onPress={() => onReceipt(order.id)} style={styles.buttonGrow} />
          {pdfAvailable ? <GhostButton testID={`button-receipt-pdf-${order.id}`} label="PDF" accessibilityLabel={`Open invoice PDF for order ${order.order_number}`} disabled={busy !== null} onPress={() => onReceipt(order.id, true)} style={styles.buttonGrow} /> : null}
        </View>
      ) : null}
    </LedgerCard>
  );
}

const canSkip = (subscription: PatientBillingSubscription) =>
  subscription.status === 'active' && !subscription.paused && !subscription.cancel_at_period_end && Boolean(subscription.next_shipment_at);

function SubscriptionCard({ subscription, busy, focused, onSkip, onCancel, onOpen }: {
  subscription: PatientBillingSubscription;
  busy: string | null;
  focused: boolean;
  onSkip: (subscription: PatientBillingSubscription) => void;
  onCancel: (subscription: PatientBillingSubscription) => void;
  onOpen: (url: string) => void;
}) {
  const colors = useColors();
  const status = subscription.cancel_at_period_end
    ? `Ends on ${date(subscription.current_period_end)}`
    : subscription.paused
      ? 'Paused'
      : subscription.status === 'past_due'
        ? 'Past due'
        : subscription.status === 'active'
          ? 'Active'
          : subscription.status === 'canceled'
            ? 'Canceled'
            : subscription.status === 'unpaid'
              ? 'Past due'
              : 'Pending';
  return (
    <LedgerCard testID={`card-subscription-${subscription.id}`} style={[styles.listCard, focused ? { borderColor: colors.cobalt, borderWidth: 2 } : null]}>
      <View style={styles.between}>
        <Text style={[styles.itemTitle, { color: colors.navy }]}>{subscription.product_name}</Text>
        <Text style={[styles.badge, { color: colors.cobalt, backgroundColor: colors.activeBg }]}>{status}</Text>
      </View>
      <Text style={[styles.body, styles.smallGap, { color: colors.bodyText }]}>
        {money(subscription.unit_price_cents)} + {money(subscription.shipping_charge_cents)} shipping
      </Text>
      {subscription.current_period_end ? <Text style={[styles.hint, { color: colors.subtleText }]}>Renews {date(subscription.current_period_end)}</Text> : null}
      {subscription.last_failure_message ? <Text style={[styles.body, styles.smallGap, { color: colors.riskText }]}>{subscription.last_failure_message}</Text> : null}
      {subscription.status === 'past_due' && subscription.last_hosted_invoice_url ? (
        <PrimaryButton testID={`button-update-payment-${subscription.id}`} label="Update payment" accessibilityLabel={`Update payment for ${subscription.product_name}`} disabled={busy !== null} onPress={() => onOpen(subscription.last_hosted_invoice_url!)} style={styles.smallGap} />
      ) : null}
      {canSkip(subscription) ? (
        <GhostButton testID={`button-skip-subscription-${subscription.id}`} label={busy === `skip:${subscription.id}` ? 'Skipping…' : `Skip shipment on ${date(subscription.next_shipment_at)}`} accessibilityLabel={`Skip the ${subscription.product_name} shipment on ${date(subscription.next_shipment_at)}`} disabled={busy !== null} onPress={() => onSkip(subscription)} style={styles.smallGap} />
      ) : null}
      {subscription.status !== 'canceled' && !subscription.cancel_at_period_end ? (
        <GhostButton testID={`button-cancel-subscription-${subscription.id}`} label={busy === `cancel:${subscription.id}` ? 'Canceling…' : 'Cancel at renewal'} accessibilityLabel={`Cancel ${subscription.product_name} at renewal`} disabled={busy !== null} onPress={() => onCancel(subscription)} style={styles.smallGap} />
      ) : null}
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { minHeight: 58, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1 },
  title: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
  spacer: { width: 22 },
  content: { padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center' },
  section: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginTop: 20, marginBottom: 8 },
  card: { padding: 14 },
  cardTitle: { fontSize: 21, fontFamily: 'PlayfairDisplay_700Bold' },
  listCard: { padding: 14, marginBottom: 10 },
  item: { flexDirection: 'row', gap: 12, borderTopWidth: 1, paddingTop: 14, marginTop: 14 },
  itemMain: { flex: 1 },
  productImage: { width: 72, height: 72, borderRadius: 7 },
  itemTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  price: { fontSize: 14, marginTop: 4, fontFamily: 'Inter_700Bold' },
  hint: { fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  badge: { overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, fontSize: 10, fontFamily: 'Inter_700Bold' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginBottom: 3 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 9 },
  buttonGrow: { flex: 1 },
  gap: { marginTop: 14 },
  smallGap: { marginTop: 9 },
  empty: { fontSize: 13, padding: 14, textAlign: 'center', fontFamily: 'Inter_500Medium' },
});