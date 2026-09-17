import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { PageScrollView } from "@/components/ui/PageScrollView";
import { useColors } from "@/hooks/useColors";
import { fonts } from "@/constants/colors";
import { useSupabaseSession } from "@/lib/supabase";
import { newUuid } from "@/lib/uuid";
import { officeBilling, OfficeBillingError } from "@/lib/office-billing-api";
import type {
  CartCheckoutResponse,
  CartLineInput,
  CartQuote,
  PrebuiltCart,
  PublicLinkProduct,
  ShippingAddress,
} from "@/lib/office-billing-types";
import {
  useOfficeBillingMutation,
  useOfficeSaleContext,
} from "@/hooks/useOfficeBilling";
import {
  Body,
  Button,
  ErrorBox,
  InlineNotice,
  LoadingBox,
  MicroLabel,
  MoneyText,
  Panel,
} from "@/components/payments/primitives";
import { Field, RadioGroup, Toggle } from "@/components/payments/dialogs";
import StaffCardForm from "@/components/payments/StaffCardForm";
import { QrCode } from "@/components/payments/QrCode";

const EMPTY_ADDRESS: ShippingAddress = {
  name: "",
  line1: "",
  line2: null,
  city: "",
  state: "",
  postal_code: "",
  country: "US",
  phone: null,
};
type Step = "products" | "method" | "card" | "qr" | "done";

export let CART_POLL_MS = 3000;
export function setCartPollMsForTests(ms: number) {
  CART_POLL_MS = ms;
}

function outcome(status: string) {
  if (status === "paid") return "Paid";
  if (status === "failed") return "Failed";
  return "Needs confirmation";
}

export default function SellToPatientScreen() {
  const params = useLocalSearchParams<{
    patientId?: string | string[];
    name?: string | string[];
  }>();
  const patientId = Array.isArray(params.patientId)
    ? params.patientId[0]
    : params.patientId;
  const name =
    (Array.isArray(params.name) ? params.name[0] : params.name) || "patient";
  const { session, sessionLoading } = useSupabaseSession();
  if (sessionLoading)
    return (
      <LoadingBox
        label="Checking your sign-in…"
        testID="sale-session-loading"
      />
    );
  if (!session?.user?.id)
    return (
      <ErrorBox
        error={new Error("Sign in to sell to a patient")}
        testID="sale-sign-in"
      />
    );
  if (!patientId)
    return (
      <ErrorBox
        error={new Error("No patient ID was provided.")}
        testID="sale-invalid-patient"
      />
    );
  return (
    <SaleFlow
      key={`${session.user.id}:${patientId}`}
      userId={session.user.id}
      patientId={patientId}
      patientName={name}
    />
  );
}

function SaleFlow({
  userId,
  patientId,
  patientName,
}: {
  userId: string;
  patientId: string;
  patientName: string;
}) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const context = useOfficeSaleContext(userId, patientId);
  const [lines, setLines] = useState<CartLineInput[]>([]);
  const [quote, setQuote] = useState<CartQuote | null>(null);
  const [step, setStep] = useState<Step>("products");
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  const [result, setResult] = useState<CartCheckoutResponse | null>(null);
  const [cart, setCart] = useState<PrebuiltCart | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    tone: "bad" | "good" | "info";
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const paymentMethod = useRef<string | null>(null);
  const nextAction = useRef<
    ((secret: string) => Promise<string | null>) | null
  >(null);
  const key = useRef(newUuid());
  const definitiveFailure = useRef(false);

  const quoteMutation = useOfficeBillingMutation(
    userId,
    (body: { patient_id: string; lines: CartLineInput[] }, scope) =>
      officeBilling.saleQuote(body, scope),
    { invalidate: false },
  );
  const checkoutMutation = useOfficeBillingMutation(
    userId,
    (
      vars: {
        body: Parameters<typeof officeBilling.saleCheckout>[0];
        key: string;
      },
      scope,
    ) => officeBilling.saleCheckout(vars.body, scope, vars.key),
  );
  const cartMutation = useOfficeBillingMutation(
    userId,
    (body: { patient_id: string; lines: CartLineInput[] }, scope) =>
      officeBilling.createCart(body, scope),
  );
  const revokeMutation = useOfficeBillingMutation(userId, (id: string, scope) =>
    officeBilling.revokeCart(id, scope),
  );

  useEffect(() => {
    if (!context.data) return;
    setContact({
      name: context.data.patient.name,
      email: context.data.patient.email ?? "",
      phone: context.data.patient.phone ?? "",
    });
    setAddress(
      context.data.default_address ?? {
        ...EMPTY_ADDRESS,
        name: context.data.patient.name,
        phone: context.data.patient.phone,
      },
    );
  }, [context.data]);

  useEffect(() => {
    if (!lines.length) {
      setQuote(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      quoteMutation.mutateAsync({ patient_id: patientId, lines }).then(
        (value) => {
          if (current) {
            setQuote(value);
            setNotice(null);
          }
        },
        (caught) => {
          if (current) {
            setQuote(null);
            setNotice({
              text:
                caught instanceof Error
                  ? caught.message
                  : "Could not update the quote.",
              tone: "bad",
            });
          }
        },
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [lines, patientId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (
      step !== "qr" ||
      !cart ||
      !["open", "verified", "checkout"].includes(cart.status)
    )
      return;
    const timer = setInterval(() => {
      officeBilling.cart(cart.id, { userId }).then(setCart, () => {});
    }, CART_POLL_MS);
    return () => clearInterval(timer);
  }, [cart?.id, cart?.status, step, userId]);
  useEffect(() => {
    if (step !== "qr") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);

  const close = () => {
    const leave = () => router.back();
    if (!checkoutMutation.isPending && !cartMutation.isPending) return leave();
    const message = "A payment is still processing. Close this screen?";
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(message)) leave();
    } else
      Alert.alert("Payment in progress", message, [
        { text: "Keep open", style: "cancel" },
        { text: "Close", style: "destructive", onPress: leave },
      ]);
  };
  const setProduct = (
    productId: string,
    patch: Partial<CartLineInput> | null,
  ) => {
    setLines((current) => {
      const old = current.find((line) => line.product_id === productId);
      if (!patch)
        return current.filter((line) => line.product_id !== productId);
      return [
        ...current.filter((line) => line.product_id !== productId),
        {
          ...(old ?? {
            product_id: productId,
            quantity: 1,
            purchase: "one_time" as const,
          }),
          ...patch,
        },
      ];
    });
  };

  const validAddress = () => {
    if (
      !contact.name.trim() ||
      !address.line1.trim() ||
      !address.city.trim() ||
      !address.state.trim() ||
      !address.postal_code.trim()
    ) {
      setNotice({
        text: "Enter the patient’s name and complete shipping address.",
        tone: "bad",
      });
      return false;
    }
    return true;
  };
  const checkout = useCallback(
    async (paymentMethodId?: string) => {
      const id = paymentMethodId ?? paymentMethod.current;
      if (!id || !quote || !validAddress()) return;
      if (paymentMethodId && definitiveFailure.current) key.current = newUuid();
      definitiveFailure.current = false;
      paymentMethod.current = id;
      setNotice(null);
      const body = {
        patient_id: patientId,
        lines,
        shipping_address: {
          ...address,
          name: contact.name,
          phone: contact.phone || null,
        },
        payment_method_id: id,
        cart_id: key.current,
      };
      try {
        let response = await checkoutMutation.mutateAsync({
          body,
          key: key.current,
        });
        setResult(response);
        definitiveFailure.current = response.status === "failed";
        if (response.status === "requires_action") {
          for (const item of response.items.filter(
            (entry) =>
              entry.status === "requires_action" && entry.client_secret,
          )) {
            const actionError = await nextAction.current?.(item.client_secret!);
            if (actionError) {
              setNotice({ text: actionError, tone: "bad" });
              return;
            }
          }
          response = await checkoutMutation.mutateAsync({
            body,
            key: key.current,
          });
          setResult(response);
        }
        if (response.status === "paid" || response.status === "partial")
          setStep("done");
      } catch (caught) {
        if (caught instanceof OfficeBillingError && caught.status === 402)
          definitiveFailure.current = true;
        setNotice({
          text:
            caught instanceof Error
              ? caught.message
              : "The sale could not be completed.",
          tone: "bad",
        });
      }
    },
    [
      address,
      checkoutMutation,
      contact.name,
      contact.phone,
      lines,
      patientId,
      quote,
    ],
  );

  const createQr = async () => {
    setNotice(null);
    try {
      setCart(await cartMutation.mutateAsync({ patient_id: patientId, lines }));
      setStep("qr");
    } catch (caught) {
      setNotice({
        text:
          caught instanceof Error
            ? caught.message
            : "Could not create the QR code.",
        tone: "bad",
      });
    }
  };
  const revoke = async () => {
    if (!cart) return;
    try {
      setCart(await revokeMutation.mutateAsync(cart.id));
    } catch (caught) {
      setNotice({
        text:
          caught instanceof Error
            ? caught.message
            : "Could not cancel the QR code.",
        tone: "bad",
      });
    }
  };
  const share = async () => {
    if (!cart) return;
    if (
      Platform.OS === "web" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard
    ) {
      try {
        await navigator.clipboard.writeText(cart.url);
        setNotice({ text: "Payment link copied.", tone: "good" });
        return;
      } catch {}
    }
    await Share.share({ message: cart.url });
  };

  const busy =
    checkoutMutation.isPending ||
    cartMutation.isPending ||
    revokeMutation.isPending;
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop:
              (Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top) +
              8,
            borderBottomColor: colors.border,
            backgroundColor: colors.paperCardAlt,
          },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            testID="sale-title"
            style={[styles.title, { color: colors.navy }]}
          >
            Sell to {patientName}
          </Text>
          <Body>
            Build an order and charge a card here or let the patient scan a QR
            code.
          </Body>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID="sale-close"
          onPress={close}
          style={styles.close}
        >
          <Feather name="x" size={20} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <PageScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 28 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {context.isPending ? (
          <LoadingBox label="Loading products…" testID="sale-context-loading" />
        ) : null}
        {context.isError ? (
          <ErrorBox
            error={context.error}
            retry={() => void context.refetch()}
            testID="sale-context-error"
          />
        ) : null}
        {notice ? (
          <InlineNotice tone={notice.tone} testID="sale-notice">
            {notice.text}
          </InlineNotice>
        ) : null}
        {context.data && !context.data.available ? (
          <Body>
            Sales are unavailable until this office connects Stripe and offers
            products.
          </Body>
        ) : null}
        {context.data?.available && step === "products" ? (
          <>
            {context.data.products.map((product) => (
              <ProductCard
                key={product.product_id}
                product={product}
                line={lines.find(
                  (line) => line.product_id === product.product_id,
                )}
                setProduct={setProduct}
              />
            ))}
            {quoteMutation.isPending ? (
              <LoadingBox label="Updating quote…" testID="sale-quote-loading" />
            ) : null}
            {quote ? <QuoteCard quote={quote} /> : null}
            <Button
              label="Continue"
              disabled={!quote}
              onPress={() => setStep("method")}
              variant="primary"
              testID="sale-continue"
            />
          </>
        ) : null}
        {step === "method" ? (
          <Panel>
            <Button
              label="Card on this phone"
              onPress={() => {
                key.current = newUuid();
                definitiveFailure.current = false;
                setStep("card");
              }}
              variant="primary"
              testID="sale-method-card"
            />
            <Button
              label="Patient scans a QR code"
              onPress={() => void createQr()}
              busy={cartMutation.isPending}
              testID="sale-method-qr"
            />
          </Panel>
        ) : null}
        {step === "card" && context.data ? (
          <>
            <AddressFields
              contact={contact}
              setContact={setContact}
              address={address}
              setAddress={setAddress}
            />
            {result?.status === "failed" ? (
              <Panel title="Sale not completed" testID="sale-failed">
                {result.items.map((item) => (
                  <Body key={item.order_id}>
                    {item.order_number}: {outcome(item.status)}
                    {item.error ? ` — ${item.error}` : ""}
                  </Body>
                ))}
                <Button
                  label="Try another card"
                  testID="sale-try-another-card"
                  onPress={() => {
                    paymentMethod.current = null;
                    key.current = newUuid();
                    definitiveFailure.current = false;
                    setResult(null);
                  }}
                />
              </Panel>
            ) : (
              <StaffCardForm
                publishableKey={context.data.publishable_key}
                stripeAccount={context.data.stripe_account_id!}
                amount={quote?.total_cents ?? 0}
                onReady={(handler) => {
                  nextAction.current = handler;
                }}
                onPaymentMethod={checkout}
                submitLabel={`Charge ${quote ? `$${(quote.total_cents / 100).toFixed(2)}` : "$0.00"}`}
              />
            )}
          </>
        ) : null}
        {step === "done" && result ? (
          <Completion
            result={result}
            go={(id) =>
              router.push({
                pathname: "/payments/transactions/[orderId]",
                params: { orderId: id },
              })
            }
          />
        ) : null}
        {step === "qr" && cart ? (
          <QrState
            cart={cart}
            now={now}
            busy={busy}
            share={share}
            revoke={revoke}
            go={(id) =>
              router.push({
                pathname: "/payments/transactions/[orderId]",
                params: { orderId: id },
              })
            }
          />
        ) : null}
      </PageScrollView>
    </View>
  );
}

function ProductCard({
  product,
  line,
  setProduct,
}: {
  product: PublicLinkProduct;
  line?: CartLineInput;
  setProduct: (id: string, patch: Partial<CartLineInput> | null) => void;
}) {
  return (
    <Panel testID={`sale-product-${product.product_id}`}>
      <View style={styles.between}>
        <View style={{ flex: 1 }}>
          <Text style={styles.productName}>{product.name}</Text>
          <Body>
            ${(product.unit_price_cents / 100).toFixed(2)} one-time
            {product.subscription_unit_price_cents != null
              ? ` · $${(product.subscription_unit_price_cents / 100).toFixed(2)} subscribe & save`
              : ""}
          </Body>
        </View>
        <Toggle
          label={`Select ${product.name}`}
          value={Boolean(line)}
          onChange={(on) => setProduct(product.product_id, on ? {} : null)}
          testID={`sale-select-${product.product_id}`}
        />
      </View>
      {line ? (
        <>
          <RadioGroup
            label="Purchase"
            value={line.purchase}
            onChange={(purchase) =>
              setProduct(product.product_id, {
                purchase,
                cadence_weeks:
                  purchase === "subscription"
                    ? product.default_cadence_weeks
                    : null,
              })
            }
            options={[
              { value: "one_time", label: "One-time" },
              ...(product.subscription_available
                ? [{ value: "subscription" as const, label: "Subscribe" }]
                : []),
            ]}
            testIDPrefix={`sale-purchase-${product.product_id}`}
          />
          {line.purchase === "subscription" ? (
            <RadioGroup
              label="Cadence"
              value={String(
                line.cadence_weeks ?? product.default_cadence_weeks,
              )}
              onChange={(weeks) =>
                setProduct(product.product_id, { cadence_weeks: Number(weeks) })
              }
              options={product.subscription_cadences_weeks.map((weeks) => ({
                value: String(weeks),
                label: `Every ${weeks} weeks`,
              }))}
              testIDPrefix={`sale-cadence-${product.product_id}`}
            />
          ) : null}
          <View style={styles.stepper}>
            <MicroLabel>Quantity</MicroLabel>
            <Button
              small
              label="Decrease"
              accessibilityLabel={`Decrease ${product.name} quantity`}
              disabled={line.quantity <= 1}
              onPress={() =>
                setProduct(product.product_id, { quantity: line.quantity - 1 })
              }
              testID={`sale-quantity-minus-${product.product_id}`}
            />
            <Text testID={`sale-quantity-${product.product_id}`}>
              {line.quantity}
            </Text>
            <Button
              small
              label="Increase"
              accessibilityLabel={`Increase ${product.name} quantity`}
              disabled={line.quantity >= 10}
              onPress={() =>
                setProduct(product.product_id, { quantity: line.quantity + 1 })
              }
              testID={`sale-quantity-plus-${product.product_id}`}
            />
          </View>
        </>
      ) : null}
    </Panel>
  );
}

function QuoteCard({ quote }: { quote: CartQuote }) {
  return (
    <Panel title="Order quote" testID="sale-quote">
      {quote.lines.map((line) => (
        <View
          key={`${line.product_id}-${line.purchase}`}
          style={styles.between}
        >
          <Body muted={false}>
            {line.quantity} × {line.name}
            {line.cadence_weeks ? ` · every ${line.cadence_weeks} weeks` : ""}
          </Body>
          <MoneyText cents={line.line_total_cents} />
        </View>
      ))}
      <View style={styles.between}>
        <Text style={styles.bold}>Subtotal</Text>
        <MoneyText cents={quote.subtotal_cents} />
      </View>
      {quote.discount_cents ? (
        <View style={styles.between}>
          <Body>Discount</Body>
          <MoneyText cents={-quote.discount_cents} signed />
        </View>
      ) : null}
      <View style={styles.between}>
        <Body>Shipping</Body>
        <MoneyText cents={quote.shipping_charge_cents} />
      </View>
      <View style={styles.between}>
        <Text style={styles.bold}>Total today</Text>
        <MoneyText cents={quote.total_cents} />
      </View>
    </Panel>
  );
}

function AddressFields({
  contact,
  setContact,
  address,
  setAddress,
}: {
  contact: { name: string; email: string; phone: string };
  setContact: React.Dispatch<
    React.SetStateAction<{ name: string; email: string; phone: string }>
  >;
  address: ShippingAddress;
  setAddress: React.Dispatch<React.SetStateAction<ShippingAddress>>;
}) {
  const contactField = (key: keyof typeof contact) => (value: string) =>
    setContact((old) => ({ ...old, [key]: value }));
  const addressField = (key: keyof ShippingAddress) => (value: string) =>
    setAddress((old) => ({
      ...old,
      [key]: value || (key === "line2" || key === "phone" ? null : ""),
    }));
  return (
    <Panel title="Contact and shipping">
      <Field
        label="Name"
        value={contact.name}
        onChangeText={contactField("name")}
        testID="sale-name"
      />
      <Field
        label="Email"
        value={contact.email}
        onChangeText={contactField("email")}
        keyboardType="email-address"
        testID="sale-email"
      />
      <Field
        label="Phone"
        value={contact.phone}
        onChangeText={contactField("phone")}
        keyboardType="phone-pad"
        testID="sale-phone"
      />
      <Field
        label="Street address"
        value={address.line1}
        onChangeText={addressField("line1")}
        testID="sale-line1"
      />
      <Field
        label="Apartment or suite"
        value={address.line2 ?? ""}
        onChangeText={addressField("line2")}
        testID="sale-line2"
      />
      <Field
        label="City"
        value={address.city}
        onChangeText={addressField("city")}
        testID="sale-city"
      />
      <Field
        label="State"
        value={address.state}
        onChangeText={addressField("state")}
        testID="sale-state"
      />
      <Field
        label="ZIP code"
        value={address.postal_code}
        onChangeText={addressField("postal_code")}
        testID="sale-postal"
      />
    </Panel>
  );
}

function Completion({
  result,
  go,
}: {
  result: CartCheckoutResponse;
  go: (id: string) => void;
}) {
  return (
    <Panel
      title={
        result.items.every((item) => item.status === "paid")
          ? "Sale complete"
          : "Partly complete"
      }
      testID="sale-completion"
    >
      {result.items.map((item) => (
        <Pressable
          key={item.order_id}
          accessibilityRole="link"
          accessibilityLabel={`View order ${item.order_number}`}
          testID={`sale-order-${item.order_id}`}
          onPress={() => go(item.order_id)}
          style={styles.order}
        >
          <Body muted={false}>
            {item.kind === "subscription" ? "Subscription" : "Order"}{" "}
            {item.order_number} · {outcome(item.status)}
          </Body>
          <MoneyText cents={item.total_cents} />
        </Pressable>
      ))}
    </Panel>
  );
}

function QrState({
  cart,
  now,
  busy,
  share,
  revoke,
  go,
}: {
  cart: PrebuiltCart;
  now: number;
  busy: boolean;
  share: () => void;
  revoke: () => void;
  go: (id: string) => void;
}) {
  const partial =
    cart.partial ||
    Boolean(
      cart.orders.some((o) => o.status === "paid") &&
      cart.orders.some((o) => o.status !== "paid"),
    );
  const terminal =
    cart.status === "paid" ||
    partial ||
    ["failed", "expired", "revoked", "locked"].includes(cart.status);
  const title = partial
    ? "Partly paid"
    : cart.status === "paid"
      ? "Paid"
      : cart.status === "verified" || cart.status === "checkout"
        ? "Phone verified"
        : cart.status === "open"
          ? "Waiting for patient"
          : cart.status[0].toUpperCase() + cart.status.slice(1);
  const remaining = Math.max(
    0,
    Math.ceil((new Date(cart.expires_at).getTime() - now) / 60000),
  );
  return (
    <Panel title={title} testID="sale-qr">
      {terminal ? (
        cart.orders.map((order) => (
          <Pressable
            key={order.order_id}
            accessibilityRole="link"
            accessibilityLabel={`View order ${order.order_number}`}
            testID={`sale-qr-order-${order.order_id}`}
            onPress={() => go(order.order_id)}
          >
            <Body>
              Order {order.order_number} · {outcome(order.status)}
            </Body>
          </Pressable>
        ))
      ) : (
        <>
          <QrCode value={cart.url} />
          <Body testID="sale-qr-url">{cart.url}</Body>
          <Body>Expires in {remaining} minutes</Body>
          <View style={styles.actions}>
            <Button
              label="Copy / Share link"
              onPress={() => void share()}
              testID="sale-qr-share"
            />
            <Button
              label="Cancel QR"
              onPress={() => void revoke()}
              busy={busy}
              variant="danger"
              testID="sale-qr-cancel"
            />
          </View>
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: { fontSize: 20, lineHeight: 26, fontFamily: fonts.serifBold },
  close: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { padding: 14, gap: 12 },
  between: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  productName: { fontSize: 14, fontFamily: "Inter_700Bold" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  bold: { fontSize: 13, fontFamily: "Inter_700Bold" },
  order: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 40,
    alignItems: "center",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
  },
});
