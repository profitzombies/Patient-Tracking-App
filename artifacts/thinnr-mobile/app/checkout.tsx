/**
 * Checkout — shipping address (pre-filled from the profile's saved address
 * or name/phone, editable), contact details, card (saved cards or a new
 * one via the platform-split StripeCardEntry), then one Pay tap that
 * confirms the whole cart in the app and lands on the confirmation screen.
 *
 * Money handling lives in lib/checkout-flow.ts: one cart id per attempt,
 * the same id AND request re-sent after an ambiguous failure (persisted in
 * the cart store BEFORE the request leaves, so a reload replays it too) so
 * the server replays rather than double-charges, a fresh id only after a
 * definite answer. While an attempt is pending the cart is locked and this
 * screen shows the frozen attempt (its lines, address, card, and authorized
 * total) with a single Confirm button instead of the editable form. The
 * request carries the total the button showed; the server refuses a cart
 * that no longer prices to it and the screen re-quotes. A partial answer
 * removes the paid lines from the cart before any retry. Paid lines leave
 * the cart only on a `paid` answer; every other result stays on this screen
 * with an announced error.
 *
 * Totals: an office that collects sales tax gets its tax estimated by the
 * server for the entered address, and Pay stays disabled until the amount
 * actually due is known; the button always names that amount.
 *
 * Demo persona: the form renders with the demo address, no card entry
 * loads (no publishable key), and Pay uses the demo convention (disabled,
 * tapping explains). Real accounts never see demo data here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { ErrorBox, FieldLabel, LedgerInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { PriceRow, ShopHeader, ShopUnavailable, demoNudge } from '@/components/shop/ShopChrome';
import { StripeCardEntry } from '@/components/shop/StripeCardEntry';
import { CARD_ENTRY_UNAVAILABLE, type CardEntryHandle } from '@/components/shop/card-entry-types';
import { useColors } from '@/hooks/useColors';
import { CartScopeChangedError, useCart } from '@/context/CartContext';
import { usePatient } from '@/context/PatientContext';
import { cadenceLabel, formatCents, localQuote, newCartId, toQuoteRequest } from '@/lib/cart-math';
import {
  buildCheckoutRequest,
  normalizeAddress,
  runCheckout,
  summarizeCheckout,
  validateAddress,
  type AddressField,
  type PendingAttempt,
} from '@/lib/checkout-flow';
import { checkoutCart, listCards, quoteCart } from '@/lib/patient-billing-api';
import { missingTokenMessage, supabase } from '@/lib/supabase';
import type { CartQuote, CartQuoteRequest, PatientCard, ShippingAddress } from '@/lib/patient-billing-types';

type CardChoice = { kind: 'saved'; id: string } | { kind: 'new' };

const EMPTY_ADDRESS: ShippingAddress = {
  name: '', line1: '', line2: null, city: '', state: '', postal_code: '', country: 'US', phone: null,
};

export default function CheckoutScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const cart = useCart();
  const { profile } = usePatient();
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);

  useEffect(() => {
    if (cart.shopStatus === 'idle') void cart.loadShop();
  }, [cart.shopStatus, cart.loadShop, cart]);

  const shop = cart.shop;
  const products = useMemo(() => (shop?.available ? shop.products : []), [shop]);
  const lines = cart.lines;
  const officeName = shop?.office?.office_name ?? 'your office';

  /* ---------- address + contact ---------- */
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  // Receipts go to the account's email: the server addresses them from the
  // patient's own record, so the field is shown, not edited, here.
  const email = profile?.email?.trim() ?? '';
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  useEffect(() => {
    if (!shop) return;
    const seedKey = `${shop.office?.provider_id ?? 'none'}:${profile?.firstName ?? ''}:${profile?.lastName ?? ''}`;
    if (prefilledFor === seedKey) return;
    setPrefilledFor(seedKey);
    const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
    setAddress(
      shop.default_address
        ? { ...shop.default_address, name: shop.default_address.name || fullName, phone: shop.default_address.phone ?? profile?.phone ?? null }
        : { ...EMPTY_ADDRESS, name: fullName, phone: profile?.phone ?? null },
    );
  }, [shop, profile, prefilledFor]);
  const [touched, setTouched] = useState(false);
  const problems = useMemo(() => validateAddress(address), [address]);
  const showProblem = (field: AddressField) => (touched ? problems[field] : undefined);
  const setField = <K extends keyof ShippingAddress>(field: K, value: ShippingAddress[K]) =>
    setAddress(current => ({ ...current, [field]: value }));

  /* ---------- quote ---------- */
  const taxEnabled = !!shop?.tax_enabled;
  const estimate = useMemo(
    () => (shop ? localQuote(lines, products, shop.shipping_charge_cents, taxEnabled) : null),
    [shop, lines, products, taxEnabled],
  );
  const [quote, setQuote] = useState<CartQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // A tax-collecting office prices tax for the destination, so the quote
  // follows the address once it is complete (debounced while typing).
  const addressComplete = Object.keys(problems).length === 0;
  const quoteRequest = useMemo<CartQuoteRequest>(
    () => (taxEnabled && addressComplete ? { ...toQuoteRequest(lines), shipping_address: normalizeAddress(address) } : toQuoteRequest(lines)),
    [taxEnabled, addressComplete, lines, address],
  );
  const signature = JSON.stringify(quoteRequest);
  // Bumped when the server refuses a stale total (422): the same request is priced again.
  const [requote, setRequote] = useState(0);
  useEffect(() => {
    if (cart.demo || !shop?.available || !lines.length) return;
    let cancelled = false;
    setQuote(null);
    const delay = quoteRequest.shipping_address ? 350 : 0;
    const timer = setTimeout(() => {
      void quoteCart(quoteRequest)
        .then(result => { if (!cancelled) { setQuote(result); setQuoteError(null); } })
        .catch((caught: unknown) => {
          if (!cancelled) setQuoteError(caught instanceof Error && caught.message ? caught.message : 'Couldn’t price your cart.');
        });
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- signature is the request's identity
  }, [cart.demo, shop?.available, lines.length, signature, requote]);
  const shown = cart.demo ? estimate : quote ?? estimate;
  /** The amount the card is charged today; null until a tax office's estimate is in. */
  const dueCents = shown?.total_due_cents ?? null;

  /* ---------- cards ---------- */
  const [cards, setCards] = useState<PatientCard[] | null>(cart.demo ? [] : null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [choice, setChoice] = useState<CardChoice>({ kind: 'new' });
  const [saveDefault, setSaveDefault] = useState(true);
  const [cardComplete, setCardComplete] = useState(false);
  const [cardSdkError, setCardSdkError] = useState<string | null>(null);
  const cardEntry = useRef<CardEntryHandle>(null);
  const loadCards = useCallback(() => {
    if (cart.demo || !shop?.available) return;
    setCardsError(null);
    void listCards()
      .then(list => {
        setCards(list.cards);
        const preferred = list.default_payment_method_id ?? list.cards[0]?.id ?? null;
        setChoice(preferred ? { kind: 'saved', id: preferred } : { kind: 'new' });
      })
      .catch((caught: unknown) => {
        setCards([]);
        setCardsError(caught instanceof Error && caught.message ? caught.message : 'Couldn’t load your saved cards.');
      });
  }, [cart.demo, shop?.available]);
  useEffect(() => { loadCards(); }, [loadCards]);

  /* ---------- pay ---------- */
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [partialNote, setPartialNote] = useState<string | null>(null);
  // A real account's unsettled attempt; the demo persona never has one.
  const pendingAttempt = cart.demo ? null : cart.pending;
  // True while a tap that STARTED from the form is in flight: the form stays
  // on screen (and its card element alive for 3DS) even though the attempt is
  // already committed. The frozen confirm view takes over only once such an
  // attempt is left unsettled, or on a return to the screen.
  const payingFromForm = useRef(false);
  const pendingMode = pendingAttempt !== null && !(paying && payingFromForm.current);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const publishableKey = shop?.publishable_key ?? null;
  const stripeAccountId = shop?.stripe_account_id ?? null;
  const cardConfig = useMemo(
    () => (publishableKey && stripeAccountId ? { publishableKey, stripeAccountId } : null),
    [publishableKey, stripeAccountId],
  );
  const cardReady = choice.kind === 'saved' || (cardConfig !== null && cardComplete && !cardSdkError);
  const formReady = addressComplete;
  const quoteFinal = !!quote && !quoteError && quote.total_due_cents !== null;
  // A pending attempt replays as-is: no form, card, or quote is needed to settle it.
  // A pending attempt replays even when the storefront is unavailable: the
  // server settles it from its own rows.
  const canPay = !cart.demo && !paying && (
    pendingAttempt !== null || (!!shop?.available && lines.length > 0 && quoteFinal && formReady && cardReady)
  );

  const explainDisabled = () => {
    if (cart.demo) return demoNudge();
    setTouched(true);
    if (!formReady) setPayError('Complete the shipping address to continue.');
    else if (!cardReady) setPayError(cardSdkError ?? 'Enter your full card details to continue.');
    else if (quoteError) setPayError(quoteError);
    else if (!quote) setPayError('Still pricing your cart. Try again in a moment.');
    else if (quote.total_due_cents === null) setPayError('Still calculating sales tax for your address. Try again in a moment.');
  };

  /**
   * The signed-in user the tap belongs to, and the bearer to send under. Read
   * once when Pay is tapped (the identity on screen) and again right before the
   * request leaves: the two must agree and the cart scope must still be active,
   * or the attempt is abandoned unsent.
   */
  const sessionIdentity = async (): Promise<{ token: string; userId: string } | null> => {
    const result = await supabase?.auth.getSession();
    const session = result?.data.session;
    return session?.access_token && session.user?.id ? { token: session.access_token, userId: session.user.id } : null;
  };

  const pay = async () => {
    if (!pendingAttempt && (!shop?.available || !quote || quote.total_due_cents === null || quoteError)) return;
    setTouched(true);
    setPayError(null);
    setPartialNote(null);
    payingFromForm.current = pendingAttempt === null;
    setPaying(true);
    // Captured before the first await: the cart (account) this tap pays for.
    const scope = cart.scope;
    try {
      if (!scope) throw new Error('Your cart isn’t ready yet. Try again in a moment.');
      const startedBy = await sessionIdentity();
      if (!startedBy) throw new Error(await missingTokenMessage('You’re signed out. Sign in again to pay.'));
      if (!cart.isCurrentScope(scope)) throw new CartScopeChangedError();
      let attempt: PendingAttempt;
      if (pendingAttempt) {
        // Settle the unfinished attempt first, exactly as it was sent: the
        // server replays that cart id instead of charging a second time.
        attempt = pendingAttempt;
      } else {
        const normalized = normalizeAddress(address);
        let paymentMethodId: string;
        if (choice.kind === 'saved') {
          paymentMethodId = choice.id;
        } else {
          if (!cardEntry.current) throw new Error(CARD_ENTRY_UNAVAILABLE);
          const created = await cardEntry.current.createPaymentMethod({
            name: normalized.name,
            email: email || null,
            phone: normalized.phone,
            address: normalized,
          });
          paymentMethodId = created.paymentMethodId;
          // The card sheet can stay open across a sign-out or account switch.
          if (!cart.isCurrentScope(scope)) throw new CartScopeChangedError();
        }
        const authorized = quote as CartQuote;
        attempt = {
          cartId: newCartId(),
          // The total on the button rides along: the server refuses a cart that no longer prices to it.
          request: buildCheckoutRequest(lines, normalized, paymentMethodId, choice.kind === 'new' ? saveDefault : false, authorized.total_due_cents as number),
          quote: authorized,
        };
        // Written and read back BEFORE the request leaves, so a reload
        // mid-flight replays it; if the device cannot store it, nothing is sent.
        await cart.commitPending(attempt, scope);
      }
      // The bearer is fixed here, for the user who tapped Pay on this cart;
      // an account that changed underneath is refused before anything is sent.
      const sender = await sessionIdentity();
      if (!sender || sender.userId !== startedBy.userId || !cart.isCurrentScope(scope)) {
        // An attempt this tap just committed was never sent: take it back so
        // its account is not asked to confirm a payment that never started.
        if (!pendingAttempt) await cart.abandonPending(attempt.cartId, scope);
        throw new CartScopeChangedError();
      }
      const { cartId, request } = attempt;
      const outcome = await runCheckout(cartId, request, {
        checkout: (input, id) => checkoutCart(input, id, { accessToken: sender.token }),
        handleNextAction: secret => {
          if (!cardEntry.current) return Promise.reject(new Error(CARD_ENTRY_UNAVAILABLE));
          return cardEntry.current.handleNextAction(secret);
        },
      });
      // Settle the store before anything else (even if the screen is gone or
      // the account changed: the settlement lands on the attempt's own cart):
      // paid lines leave and the attempt is released in one device write.
      if (outcome.kind === 'paid') await cart.settlePending(outcome.response.items, scope);
      else if (outcome.nextCartId === 'new') await cart.settlePending(outcome.paid, scope);
      if (!mounted.current || !cart.isCurrentScope(scope)) return;
      if (outcome.kind === 'paid') {
        const summary = summarizeCheckout(outcome.response);
        router.replace({
          pathname: '/order-confirmation',
          params: {
            orders: summary.orderNumbers.join(','),
            subscriptions: summary.subscriptionOrderNumbers.join(','),
            total: String(summary.totalCents),
            office: officeName,
          },
        });
        return;
      }
      if (outcome.nextCartId === 'new') {
        // Definite answer: this attempt is over. Anything it DID charge has
        // already left the cart so the next attempt cannot charge it again.
        if (outcome.paid.length) {
          setPartialNote(`Paid: ${outcome.paid.map(item => item.order_number).join(', ')}. Only the items still in your cart will be charged next.`);
        }
        // Re-price before asking again: the amount may have moved under the
        // button (422 or the server's finalized-total check), and the next tap
        // must show and bind what will actually be charged.
        setRequote(n => n + 1);
      }
      // Ambiguous: the attempt stays committed exactly as written; the next tap replays it.
      setPayError(outcome.message);
    } catch (caught) {
      // Only the card SDK (tokenizing a new card), the device store, or the
      // scope/session check rejects here; no charge was attempted.
      if (mounted.current && (!scope || cart.isCurrentScope(scope) || caught instanceof CartScopeChangedError)) {
        setPayError(caught instanceof Error && caught.message ? caught.message : 'Your card couldn’t be used.');
      }
    } finally {
      payingFromForm.current = false;
      if (mounted.current) setPaying(false);
    }
  };

  const subscriptionLines = shown?.lines.filter(line => line.purchase === 'subscription') ?? [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <ShopHeader title="Checkout" testIDPrefix="checkout" backFallback={'/cart' as Href} cartButton={false} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        bottomOffset={72}
      >
        <ShopUnavailable
          shop={shop}
          status={cart.shopStatus}
          error={cart.shopError}
          onRetry={() => void cart.loadShop(true)}
          testIDPrefix="checkout"
        />
        {pendingMode && pendingAttempt ? (
          <PendingConfirm
            attempt={pendingAttempt}
            cards={cards}
            officeName={officeName}
            paying={paying}
            error={payError}
            onConfirm={() => void pay()}
          />
        ) : null}
        {pendingMode && cardConfig ? (
          // Mounted (hidden) so a replay that still needs the bank step can run 3DS.
          <StripeCardEntry
            ref={cardEntry}
            config={cardConfig}
            onChange={setCardComplete}
            onError={setCardSdkError}
            disabled={paying}
            hidden
            testID="checkout-card-entry"
          />
        ) : null}
        {!pendingMode && shop?.available && cart.hydrated && !lines.length ? (
          <View testID="checkout-empty" style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.bodyText }]}>Your cart is empty.</Text>
            <PrimaryButton testID="checkout-browse" label="Browse the shop" onPress={() => router.replace('/shop' as Href)} style={{ marginTop: 12, alignSelf: 'stretch' }} />
          </View>
        ) : null}
        {!pendingMode && shop?.available && lines.length ? (
          <>
            {cart.demo ? (
              <Text testID="checkout-demo-note" style={[styles.demoNote, { color: colors.orangeText }]}>
                Demo checkout — the form is live, payment needs a patient account.
              </Text>
            ) : null}

            <SectionHeader label="Ship to" style={styles.sectionGap} />
            <LedgerCard testID="checkout-address" style={{ padding: 14, gap: 10 }}>
              <Field label="Full name" testID="checkout-name" value={address.name} onChangeText={value => setField('name', value)} error={showProblem('name')} autoComplete="name" textContentType="name" />
              <Field label="Street address" testID="checkout-line1" value={address.line1} onChangeText={value => setField('line1', value)} error={showProblem('line1')} autoComplete="street-address" textContentType="streetAddressLine1" />
              <Field label="Apt, suite (optional)" testID="checkout-line2" value={address.line2 ?? ''} onChangeText={value => setField('line2', value || null)} textContentType="streetAddressLine2" />
              <View style={styles.twoUp}>
                <View style={{ flex: 2 }}>
                  <Field label="City" testID="checkout-city" value={address.city} onChangeText={value => setField('city', value)} error={showProblem('city')} textContentType="addressCity" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="State" testID="checkout-state" value={address.state} onChangeText={value => setField('state', value.toUpperCase().slice(0, 2))} error={showProblem('state')} autoCapitalize="characters" maxLength={2} textContentType="addressState" />
                </View>
              </View>
              <View style={styles.twoUp}>
                <View style={{ flex: 1 }}>
                  <Field label="ZIP" testID="checkout-postal" value={address.postal_code} onChangeText={value => setField('postal_code', value)} error={showProblem('postal_code')} keyboardType="number-pad" textContentType="postalCode" />
                </View>
                <View style={{ flex: 1 }}>
                  <FieldLabel text="Country" />
                  <View style={[styles.staticField, { borderColor: colors.border, backgroundColor: colors.paperCardAlt, borderRadius: colors.radiusSm }]}>
                    <Text style={[styles.staticText, { color: colors.bodyText }]}>United States</Text>
                  </View>
                </View>
              </View>
            </LedgerCard>

            <SectionHeader label="Contact" style={styles.sectionGap} />
            <LedgerCard testID="checkout-contact" style={{ padding: 14, gap: 10 }}>
              <View style={{ gap: 4 }}>
                <FieldLabel text="Receipts" />
                <View style={[styles.staticField, { borderColor: colors.border, backgroundColor: colors.paperCardAlt, borderRadius: colors.radiusSm }]}>
                  <Text testID="checkout-email" style={[styles.staticText, { color: colors.bodyText }]} numberOfLines={1}>
                    {email || 'Sent to the email on your account'}
                  </Text>
                </View>
                <Text style={[styles.note, { color: colors.subtleText, marginTop: 0 }]}>Receipts go to your account email. Change it from Account.</Text>
              </View>
              <Field label="Phone (optional)" testID="checkout-phone" value={address.phone ?? ''} onChangeText={value => setField('phone', value || null)} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" />
            </LedgerCard>

            <SectionHeader label="Payment" style={styles.sectionGap} />
            <LedgerCard testID="checkout-payment" style={{ padding: 14, gap: 10 }}>
              {cardsError ? <ErrorBox testID="checkout-cards-error" message={cardsError} /> : null}
              {cards && cards.length ? (
                <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
                  {cards.map(card => (
                    <CardOption
                      key={card.id}
                      testID={`checkout-card-${card.id}`}
                      label={`${brandLabel(card.brand)} ending in ${card.last4}`}
                      hint={`Expires ${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}${card.is_default ? ' · Default' : ''}`}
                      selected={choice.kind === 'saved' && choice.id === card.id}
                      onSelect={() => setChoice({ kind: 'saved', id: card.id })}
                    />
                  ))}
                  <CardOption
                    testID="checkout-card-new"
                    label="Use a new card"
                    hint={null}
                    selected={choice.kind === 'new'}
                    onSelect={() => setChoice({ kind: 'new' })}
                  />
                </View>
              ) : null}
              {cardConfig ? (
                <View style={{ gap: 10 }}>
                  {choice.kind === 'new' ? <FieldLabel text="Card" /> : null}
                  {/* Stays mounted behind a saved card so 3DS can complete on it. */}
                  <StripeCardEntry
                    ref={cardEntry}
                    config={cardConfig}
                    onChange={setCardComplete}
                    onError={setCardSdkError}
                    disabled={paying}
                    hidden={choice.kind !== 'new'}
                    testID="checkout-card-entry"
                  />
                  {choice.kind === 'new' ? (
                    <>
                      {cardSdkError ? <ErrorBox testID="checkout-card-sdk-error" message={cardSdkError} /> : null}
                      <View style={styles.switchRow}>
                        <Text style={[styles.switchLabel, { color: colors.bodyText }]}>Save this card for renewals and next time</Text>
                        <Switch
                          testID="checkout-save-card"
                          value={saveDefault}
                          onValueChange={setSaveDefault}
                          accessibilityLabel="Save this card"
                          trackColor={{ false: colors.track, true: colors.cobalt }}
                        />
                      </View>
                    </>
                  ) : null}
                </View>
              ) : choice.kind === 'new' ? (
                <View testID="checkout-card-placeholder" style={[styles.staticField, { borderColor: colors.border, backgroundColor: colors.paperCardAlt, borderRadius: colors.radiusSm }]}>
                  <Text style={[styles.staticText, { color: colors.subtleText }]}>
                    {cart.demo ? 'Card entry is available with a patient account.' : 'Card entry isn’t available for this office right now.'}
                  </Text>
                </View>
              ) : null}
              {shop.sandbox && !cart.demo ? (
                <Text testID="checkout-sandbox" style={[styles.note, { color: colors.orangeText }]}>Test mode — no real charge will be made.</Text>
              ) : null}
            </LedgerCard>

            <SectionHeader label="Order summary" style={styles.sectionGap} />
            <LedgerCard testID="checkout-summary" style={{ padding: 14 }}>
              {shown?.lines.map(line => (
                <View key={`${line.product_id}:${line.purchase}`} style={styles.summaryRow}>
                  <Text style={[styles.summaryName, { color: colors.navy }]} numberOfLines={2}>
                    {line.quantity} × {line.name}
                    {line.purchase === 'subscription' ? ` · ${cadenceLabel(line.cadence_weeks).toLowerCase()}` : ''}
                  </Text>
                  <Text style={[styles.summaryAmt, { color: colors.navy }]}>{formatCents(line.line_total_cents)}</Text>
                </View>
              ))}
              <Divider style={{ marginVertical: 6 }} />
              {shown ? (
                <>
                  {shown.discount_cents > 0 ? <PriceRow label="Subscribe & save" cents={shown.discount_cents} discount /> : null}
                  <PriceRow label="Shipping" cents={shown.shipping_charge_cents} testID="checkout-shipping" />
                  {shown.tax_enabled ? (
                    shown.tax_cents === null ? (
                      <View style={styles.summaryRow} testID="checkout-tax-pending">
                        <Text style={[styles.summaryName, { color: colors.bodyText }]}>Estimated sales tax</Text>
                        <Text style={[styles.summaryAmt, { color: colors.subtleText }]}>{addressComplete && !quoteError ? 'Calculating…' : 'Enter address'}</Text>
                      </View>
                    ) : (
                      <PriceRow label="Estimated sales tax" cents={shown.tax_cents} testID="checkout-tax" />
                    )
                  ) : null}
                  {dueCents !== null ? (
                    <PriceRow label="Total today" cents={dueCents} strong testID="checkout-total" />
                  ) : (
                    <PriceRow label="Total before tax" cents={shown.total_cents} strong testID="checkout-total-before-tax" />
                  )}
                </>
              ) : null}
              {quoteError ? <ErrorBox testID="checkout-quote-error" message={quoteError} /> : null}
              {partialNote ? (
                <Text testID="checkout-partial-note" accessibilityLiveRegion="polite" style={[styles.note, { color: colors.orangeText }]}>{partialNote}</Text>
              ) : null}
              {subscriptionLines.length ? (
                <Text style={[styles.note, { color: colors.subtleText }]}>
                  {subscriptionLines.length === 1 ? 'Your subscription renews' : 'Your subscriptions renew'} automatically at the same price plus shipping. Cancel anytime from Payments & orders.
                </Text>
              ) : null}
              {payError ? <ErrorBox testID="checkout-error" message={payError} /> : null}
              <PrimaryButton
                testID="checkout-pay"
                label={paying ? 'Paying…' : dueCents !== null ? `Pay ${formatCents(dueCents)}` : 'Pay'}
                disabled={!canPay}
                onDisabledPress={paying ? undefined : explainDisabled}
                onPress={() => void pay()}
                style={{ marginTop: 12 }}
              />
              <Text style={[styles.fine, { color: colors.subtleText }]}>
                Paid securely through Stripe to {officeName}.
              </Text>
            </LedgerCard>
          </>
        ) : null}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

/**
 * The frozen attempt awaiting a definite answer: exactly the lines, address,
 * card, and total that were sent, with one Confirm button. Nothing here is
 * editable; the cart itself is locked until the server settles it.
 */
function PendingConfirm({ attempt, cards, officeName, paying, error, onConfirm }: {
  attempt: PendingAttempt;
  cards: PatientCard[] | null;
  officeName: string;
  paying: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const colors = useColors();
  const { quote, request } = attempt;
  const address = request.shipping_address;
  const card = cards?.find(candidate => candidate.id === request.payment_method_id) ?? null;
  const due = quote.total_due_cents ?? quote.total_cents;
  return (
    <>
      <SectionHeader label="Confirm payment" style={styles.sectionGap} />
      <LedgerCard testID="checkout-pending" style={{ padding: 14 }}>
        <Text testID="checkout-pending-note" accessibilityLiveRegion="polite" style={[styles.pendingLead, { color: colors.navy }]}>
          Your last payment attempt hasn’t been confirmed yet. Tap Confirm to check on it. Nothing new is charged until it settles, and your cart can’t change until then.
        </Text>
        <Divider style={{ marginVertical: 10 }} />
        {quote.lines.map(line => (
          <View key={`${line.product_id}:${line.purchase}`} style={styles.summaryRow}>
            <Text style={[styles.summaryName, { color: colors.navy }]} numberOfLines={2}>
              {line.quantity} × {line.name}
              {line.purchase === 'subscription' ? ` · ${cadenceLabel(line.cadence_weeks).toLowerCase()}` : ''}
            </Text>
            <Text style={[styles.summaryAmt, { color: colors.navy }]}>{formatCents(line.line_total_cents)}</Text>
          </View>
        ))}
        <Divider style={{ marginVertical: 6 }} />
        {quote.discount_cents > 0 ? <PriceRow label="Subscribe & save" cents={quote.discount_cents} discount /> : null}
        <PriceRow label="Shipping" cents={quote.shipping_charge_cents} testID="checkout-pending-shipping" />
        {quote.tax_enabled && quote.tax_cents !== null ? <PriceRow label="Estimated sales tax" cents={quote.tax_cents} testID="checkout-pending-tax" /> : null}
        <PriceRow label="Total today" cents={due} strong testID="checkout-pending-total" />
        <Text testID="checkout-pending-ship-to" style={[styles.note, { color: colors.bodyText }]}>
          Ships to {address.name}, {address.line1}{address.line2 ? `, ${address.line2}` : ''}, {address.city}, {address.state} {address.postal_code}.
        </Text>
        <Text testID="checkout-pending-card" style={[styles.note, { color: colors.bodyText, marginTop: 4 }]}>
          {card ? `Charged to ${brandLabel(card.brand)} ending in ${card.last4}.` : 'Charged to the card you entered.'}
        </Text>
        {error ? <ErrorBox testID="checkout-error" message={error} /> : null}
        <PrimaryButton
          testID="checkout-pay"
          label={paying ? 'Confirming…' : `Confirm payment of ${formatCents(due)}`}
          disabled={paying}
          onPress={onConfirm}
          style={{ marginTop: 12 }}
        />
        <Text style={[styles.fine, { color: colors.subtleText }]}>
          Paid securely through Stripe to {officeName}.
        </Text>
      </LedgerCard>
    </>
  );
}

function brandLabel(brand: string): string {
  const map: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };
  return map[brand.toLowerCase()] ?? (brand ? brand[0].toUpperCase() + brand.slice(1) : 'Card');
}

function CardOption({ testID, label, hint, selected, onSelect }: { testID: string; label: string; hint: string | null; selected: boolean; onSelect: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      accessibilityState={{ checked: selected }}
      onPress={onSelect}
      style={[
        styles.cardOption,
        { borderColor: selected ? colors.cobalt : colors.border, backgroundColor: selected ? colors.activeBg : colors.card, borderRadius: colors.radiusSm },
      ]}
    >
      <Feather name={selected ? 'check-circle' : 'circle'} size={16} color={selected ? colors.cobalt : colors.subtleText} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.cardOptionLabel, { color: colors.navy }]}>{label}</Text>
        {hint ? <Text style={[styles.cardOptionHint, { color: colors.subtleText }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

type FieldProps = React.ComponentProps<typeof LedgerInput> & { label: string; error?: string; testID: string };
function Field({ label, error, testID, ...input }: FieldProps) {
  const colors = useColors();
  return (
    <View style={{ gap: 4 }}>
      <FieldLabel text={label} />
      <LedgerInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error}
        aria-invalid={!!error}
        {...input}
      />
      {error ? <Text testID={`${testID}-error`} style={[styles.fieldError, { color: colors.riskText }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, maxWidth: 560, width: '100%', alignSelf: 'center' },
  sectionGap: { marginTop: 14, marginBottom: 8 },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  demoNote: { fontSize: 11.5, lineHeight: 16, fontFamily: 'Inter_600SemiBold' },
  pendingLead: { fontSize: 13, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  twoUp: { flexDirection: 'row', gap: 10 },
  staticField: { borderWidth: 1, minHeight: 46, justifyContent: 'center', paddingHorizontal: 12, marginTop: 4 },
  staticText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  fieldError: { fontSize: 11.5, fontFamily: 'Inter_600SemiBold' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchLabel: { flex: 1, fontSize: 12.5, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  cardOption: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  cardOptionLabel: { fontSize: 13.5, fontFamily: 'Inter_600SemiBold' },
  cardOptionHint: { fontSize: 11.5, fontFamily: 'Inter_400Regular', marginTop: 1 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  summaryName: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },
  summaryAmt: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  note: { fontSize: 11, lineHeight: 15, fontFamily: 'Inter_400Regular', marginTop: 8 },
  fine: { fontSize: 10.5, lineHeight: 14, fontFamily: 'Inter_400Regular', marginTop: 10, textAlign: 'center' },
});
