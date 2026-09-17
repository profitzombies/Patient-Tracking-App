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
import { useColors } from '@/hooks/useColors';
import {
  createCheckoutLink,
  getBillingOverview,
} from '@/lib/patient-billing-api';
import { subscriptionHref } from '@/lib/patient-billing-core';
import type {
  PatientBillingOverview,
  ProductPageContent,
  PublicLinkProduct,
} from '@/lib/patient-billing-types';

const DEMO_OVERVIEW: PatientBillingOverview = {
  office: { provider_id: 'demo', office_name: 'Jenkins Wellness', payments_available: true },
  shipping_charge_cents: 1000,
  products: [
    { ...DEMO_PAGE, product_id: 'demo-control', slug: 'control', name: 'Control', description: 'Daily metabolic support.', image_url: null, image_urls: [], unit_price_cents: 6999, office_priced: true, subscription_available: true, subscription_cadences_weeks: [4, 8], default_cadence_weeks: 4, subscribe_save_percent: 10, subscription_unit_price_cents: 6299 },
    { ...DEMO_PAGE, product_id: 'demo-hydrate', slug: 'hydrate', name: 'Hydrate', description: 'Electrolyte drink mix.', image_url: null, image_urls: [], unit_price_cents: 3499, office_priced: true, subscription_available: true, subscription_cadences_weeks: [4, 8], default_cadence_weeks: 4, subscribe_save_percent: 10, subscription_unit_price_cents: 3149 },
    { ...DEMO_PAGE, product_id: 'demo-protein', slug: 'protein', name: 'Protein', description: 'Vanilla protein blend.', image_url: null, image_urls: [], unit_price_cents: 4499, office_priced: true, subscription_available: false, subscription_cadences_weeks: [], default_cadence_weeks: 4, subscribe_save_percent: 0, subscription_unit_price_cents: null },
  ],
  orders: [],
  subscriptions: [],
};

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
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

export default function BillingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { account } = usePatientAccount();
  const demo = account.kind === 'demo';
  const [overview, setOverview] = useState<PatientBillingOverview | null>(demo ? DEMO_OVERVIEW : null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const load = useCallback(async () => {
    if (account.kind !== 'real') return;
    setLoading(true);
    setError(null);
    try {
      const result = await getBillingOverview();
      if (mounted.current) setOverview(result);
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

  // Email deep links still land on /billing?subscription=<id>[&action=skip];
  // the plan now lives on its own screen, which owns the linked action.
  const deepLink = useLocalSearchParams<{ subscription?: string | string[]; action?: string | string[] }>();
  const linkedSubscriptionId = Array.isArray(deepLink.subscription) ? deepLink.subscription[0] : deepLink.subscription;
  const linkedAction = Array.isArray(deepLink.action) ? deepLink.action[0] : deepLink.action;
  useEffect(() => {
    if (!linkedSubscriptionId) return;
    const query = linkedAction ? `?action=${encodeURIComponent(linkedAction)}` : '';
    router.replace(`${subscriptionHref(linkedSubscriptionId)}${query}` as never);
  }, [linkedSubscriptionId, linkedAction]);

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

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable testID="billing-back" accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={10}>
          <Feather name="chevron-left" size={22} color={colors.navy} />
        </Pressable>
        <Text style={[styles.title, { color: colors.navy }]}>Shop & payments</Text>
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
            <Text style={[styles.section, { color: colors.labelText }]}>YOUR PURCHASES</Text>
            <LedgerCard testID="card-purchase-links" style={styles.linkCard}>
              <PurchaseLink testID="button-open-orders" title="Orders" body="Every order, its receipt, and where the package is." onPress={() => router.push('/orders' as never)} />
              <PurchaseLink testID="button-open-subscriptions" title="Subscriptions" body="Move, skip, pause, or cancel what renews." onPress={() => router.push('/my-subscriptions' as never)} last />
            </LedgerCard>
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

function PurchaseLink({ testID, title, body, onPress, last = false }: { testID: string; title: string; body: string; onPress: () => void; last?: boolean }) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Open ${title.toLowerCase()}`}
      onPress={onPress}
      style={({ pressed }) => [styles.linkRow, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.itemMain}>
        <Text style={[styles.itemTitle, { color: colors.navy }]}>{title}</Text>
        <Text style={[styles.hint, { color: colors.subtleText }]}>{body}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={colors.cobalt} />
    </Pressable>
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
  linkCard: { paddingHorizontal: 14 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, minHeight: 60 },
  item: { flexDirection: 'row', gap: 12, borderTopWidth: 1, paddingTop: 14, marginTop: 14 },
  itemMain: { flex: 1 },
  productImage: { width: 72, height: 72, borderRadius: 7 },
  itemTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  price: { fontSize: 14, marginTop: 4, fontFamily: 'Inter_700Bold' },
  hint: { fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  badge: { overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, fontSize: 10, fontFamily: 'Inter_700Bold' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginBottom: 3 },
  gap: { marginTop: 14 },
  smallGap: { marginTop: 9 },
});

/** Product-page copy is not shown on this screen; the demo rows carry empty content. */
const DEMO_PAGE: ProductPageContent = {
  category: 'supplement', tagline: '', format: '', benefits: [], how_to_take: '', facts_title: '', facts: [], faqs: [], disclaimer: '',
};
