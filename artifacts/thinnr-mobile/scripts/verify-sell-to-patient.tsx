import React from "react";
import QRCode from "qrcode";
import {
  check,
  finish,
  isBlocked,
  mount,
  one,
  paths,
  press,
  requests,
  resetRequests,
  section,
  setScript,
  settle,
  STAFF,
  text,
  type,
  writes,
} from "./payments-stubs/harness";
import {
  setSearchParams,
  setPathname,
} from "./provider-training-stubs/expo-router";
import { setStaffCardBridgeForTests } from "../lib/staff-card-bridge";
import SellToPatientScreen, {
  setCartPollMsForTests,
} from "../app/sell-to-patient";
import type {
  CartCheckoutResponse,
  CartQuote,
  PrebuiltCart,
  StaffSaleContext,
} from "../lib/office-billing-types";

setPathname("/sell-to-patient");
setSearchParams({ patientId: "p1", name: "Ada Lovelace" });
setCartPollMsForTests(10);

const PRODUCT = {
  product_id: "prod_1",
  name: "Daily Balance",
  description: "Daily support",
  image_url: null,
  category: "supplement",
  tagline: "Feel balanced",
  format: "60 capsules",
  benefits: [],
  how_to_take: "",
  facts_title: "Ingredients",
  facts: [],
  faqs: [],
  disclaimer: "",
  unit_price_cents: 5000,
  office_priced: true,
  subscription_available: true,
  subscription_cadences_weeks: [4, 8],
  default_cadence_weeks: 4,
  subscribe_save_percent: 10,
  subscription_unit_price_cents: 4500,
} as const;
const ADDRESS = {
  name: "Ada Lovelace",
  line1: "1 Main St",
  line2: null,
  city: "Boston",
  state: "MA",
  postal_code: "02110",
  country: "US",
  phone: "5551234567",
};
const CONTEXT: StaffSaleContext = {
  patient: {
    id: "p1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "5551234567",
  },
  default_address: ADDRESS,
  products: [PRODUCT],
  shipping_charge_cents: 500,
  subscribe_save_percent: 10,
  stripe_account_id: "acct_1",
  publishable_key: "pk_test_1",
  sandbox: true,
  available: true,
  unavailable_reason: null,
};
const LINES = [
  { product_id: "prod_1", quantity: 1, purchase: "one_time" as const },
];
const QUOTE: CartQuote = {
  lines: [
    {
      product_id: "prod_1",
      name: "Daily Balance",
      purchase: "one_time",
      quantity: 1,
      cadence_weeks: null,
      unit_price_cents: 5000,
      list_price_cents: 5000,
      discount_cents: 0,
      line_total_cents: 5000,
    },
  ],
  groups: [
    {
      kind: "one_time",
      product_id: null,
      cadence_weeks: null,
      quantity: 1,
      subtotal_cents: 5000,
      shipping_charge_cents: 500,
      total_cents: 5500,
    },
  ],
  subtotal_cents: 5000,
  discount_cents: 0,
  shipping_charge_cents: 500,
  total_cents: 5500,
};
const PAID: CartCheckoutResponse = {
  cart_id: "ignored",
  status: "paid",
  stripe_account_id: "acct_1",
  publishable_key: "pk_test_1",
  sandbox: true,
  items: [
    {
      kind: "one_time",
      order_id: "order_1",
      order_number: "1001",
      subscription_id: null,
      status: "paid",
      client_secret: null,
      error: null,
      total_cents: 5500,
    },
  ],
};
function cart(
  status: PrebuiltCart["status"],
  orders: PrebuiltCart["orders"] = [],
): PrebuiltCart {
  return {
    id: "cart_1",
    token: "short",
    url: "https://pay.thinnr.example/c/short",
    status,
    partial: false,
    patient: { id: "p1", name: "Ada Lovelace" },
    lines: LINES,
    quote: QUOTE,
    label: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    created_at: new Date().toISOString(),
    paid_at: status === "paid" ? new Date().toISOString() : null,
    orders,
  };
}
function baseScript(
  extra?: (
    req: (typeof requests)[number],
  ) => { status: number; body: unknown } | undefined,
) {
  setScript((req) => {
    const custom = extra?.(req);
    if (custom) return custom;
    if (req.path === "/api/billing/office/sales/context")
      return { status: 200, body: CONTEXT };
    if (req.path === "/api/billing/office/sales/quote")
      return { status: 200, body: QUOTE };
    return undefined;
  });
}
async function ready() {
  const screen = await mount(<SellToPatientScreen />, STAFF);
  await press(screen.root, "sale-select-prod_1");
  await settle(45);
  await press(screen.root, "sale-continue");
  return screen;
}

async function main() {
  section("Signed out");
  resetRequests();
  baseScript();
  const signedOut = await mount(<SellToPatientScreen />, null);
  check(
    "signed-out notice is explicit",
    text(signedOut.root, "sale-sign-in").includes(
      "Sign in to sell to a patient",
    ),
  );
  check(
    "signed out performs zero fetches",
    requests.length === 0,
    paths().join(" | "),
  );
  await signedOut.unmount();

  section("Context, quote, loading and retry");
  resetRequests();
  baseScript();
  const screen = await mount(<SellToPatientScreen />, STAFF);
  const contextReq = requests.find((r) => r.path.endsWith("/sales/context"));
  check(
    "context GET has patient query and bearer",
    contextReq?.method === "GET" &&
      contextReq.auth === "Bearer staff-token" &&
      contextReq.url.includes("patient_id=p1"),
    contextReq?.url,
  );
  await press(screen.root, "sale-select-prod_1");
  await settle(45);
  const quoteReq = requests.find((r) => r.path.endsWith("/sales/quote"));
  check(
    "quote POST body is exact",
    JSON.stringify(quoteReq?.body) ===
      JSON.stringify({ patient_id: "p1", lines: LINES }),
    JSON.stringify(quoteReq?.body),
  );
  check(
    "quote renders and Continue enables",
    !!one(screen.root, "sale-quote") &&
      !isBlocked(screen.root, "sale-continue"),
  );
  await screen.unmount();
  resetRequests();
  baseScript((req) =>
    req.path.endsWith("/sales/context")
      ? { status: 500, body: { error: "context broke" } }
      : undefined,
  );
  const errored = await mount(<SellToPatientScreen />, STAFF);
  check(
    "context failure is announced with retry",
    !!one(errored.root, "sale-context-error") &&
      !!one(errored.root, "sale-context-error-retry"),
  );
  baseScript();
  await press(errored.root, "sale-context-error-retry");
  check("context retry recovers", !!one(errored.root, "sale-select-prod_1"));
  await errored.unmount();

  section("Validation and card checkout");
  resetRequests();
  baseScript();
  setStaffCardBridgeForTests({ createPaymentMethod: async () => "pm_bad" });
  const invalid = await ready();
  await press(invalid.root, "sale-method-card");
  await type(invalid.root, "sale-line1", "");
  resetRequests();
  await press(invalid.root, "button-charge-card");
  check(
    "invalid address blocks checkout client-side",
    writes().length === 0 &&
      text(invalid.root, "sale-notice").includes("complete shipping address"),
  );
  await invalid.unmount();

  let payCalls = 0;
  resetRequests();
  baseScript((req) => {
    if (req.path.endsWith("/sales")) {
      payCalls += 1;
      return payCalls === 1
        ? { status: 402, body: { error: "Your card was declined." } }
        : { status: 200, body: PAID };
    }
    return undefined;
  });
  let pm = 0;
  setStaffCardBridgeForTests({ createPaymentMethod: async () => `pm_${++pm}` });
  const card = await ready();
  await press(card.root, "sale-method-card");
  resetRequests();
  await press(card.root, "button-charge-card");
  const first = requests.find((r) => r.path.endsWith("/sales"))!;
  check(
    "402 server message is shown",
    text(card.root, "sale-notice").includes("Your card was declined."),
  );
  await press(card.root, "button-charge-card");
  const sales = requests.filter((r) => r.path.endsWith("/sales"));
  check(
    "checkout body is exact",
    JSON.stringify(first.body) ===
      JSON.stringify({
        patient_id: "p1",
        lines: LINES,
        shipping_address: ADDRESS,
        payment_method_id: "pm_1",
        cart_id: (first.body as any).cart_id,
      }),
  );
  check(
    "idempotency header matches cart id",
    !!first.headers["Idempotency-Key"] &&
      first.headers["Idempotency-Key"] === (first.body as any).cart_id,
  );
  check(
    "new key minted after definitive 402",
    sales.length === 2 &&
      sales[0].headers["Idempotency-Key"] !==
        sales[1].headers["Idempotency-Key"],
  );
  check(
    "paid completion and order link render",
    !!one(card.root, "sale-completion") &&
      !!one(card.root, "sale-order-order_1"),
  );
  await card.unmount();

  section("Requires action");
  resetRequests();
  let attempts = 0;
  let actions = 0;
  const NEEDS: CartCheckoutResponse = {
    ...PAID,
    status: "requires_action",
    items: [
      {
        ...PAID.items[0],
        status: "requires_action",
        client_secret: "pi_secret",
      },
    ],
  };
  baseScript((req) =>
    req.path.endsWith("/sales")
      ? { status: 200, body: ++attempts === 1 ? NEEDS : PAID }
      : undefined,
  );
  setStaffCardBridgeForTests({
    createPaymentMethod: async () => "pm_3ds",
    handleNextAction: async (secret) => {
      if (secret === "pi_secret") actions += 1;
      return null;
    },
  });
  const actionScreen = await ready();
  await press(actionScreen.root, "sale-method-card");
  resetRequests();
  await press(actionScreen.root, "button-charge-card");
  check(
    "requires_action invokes handler then re-posts",
    actions === 1 &&
      requests.filter((r) => r.path.endsWith("/sales")).length === 2,
  );
  check(
    "requires_action retry keeps idempotency key",
    requests
      .filter((r) => r.path.endsWith("/sales"))
      .every(
        (r, _i, a) =>
          r.headers["Idempotency-Key"] === a[0].headers["Idempotency-Key"],
      ),
  );
  await actionScreen.unmount();

  section("QR create, poll and revoke");
  setCartPollMsForTests(100);
  resetRequests();
  let polls = 0;
  const open = cart("open");
  const paidCart = cart("paid", [
    {
      order_id: "qr_order",
      order_number: "2002",
      kind: "one_time",
      status: "paid",
    },
  ]);
  baseScript((req) => {
    if (req.path === "/api/billing/office/carts" && req.method === "POST")
      return { status: 200, body: open };
    if (
      req.path === "/api/billing/office/carts/cart_1" &&
      req.method === "GET"
    ) {
      polls += 1;
      return { status: 200, body: paidCart };
    }
    return undefined;
  });
  const qr = await ready();
  resetRequests();
  await press(qr.root, "sale-method-qr");
  const create = requests.find(
    (r) => r.path === "/api/billing/office/carts" && r.method === "POST",
  );
  check(
    "cart POST body is exact",
    JSON.stringify(create?.body) ===
      JSON.stringify({ patient_id: "p1", lines: LINES }),
    JSON.stringify(create?.body),
  );
  const matrixSize = QRCode.create(open.url, { errorCorrectionLevel: "M" })
    .modules.size;
  const rects = qr.root.findAll((node) => node.type === "Rect");
  check(
    "QR draws one rect per module",
    rects.length === matrixSize * matrixSize,
    `${rects.length} vs ${matrixSize * matrixSize}`,
  );
  await settle(20);
  check(
    "poll issued and paid state replaces QR controls",
    polls === 1 &&
      !!one(qr.root, "sale-qr-order-qr_order") &&
      !one(qr.root, "sale-qr-cancel"),
    String(polls),
  );
  await settle(20);
  check("polling stops after paid", polls === 1, String(polls));
  await qr.unmount();

  resetRequests();
  baseScript((req) => {
    if (req.path === "/api/billing/office/carts" && req.method === "POST")
      return { status: 200, body: open };
    if (req.path.endsWith("/revoke"))
      return { status: 200, body: cart("revoked") };
    if (req.path === "/api/billing/office/carts/cart_1")
      return { status: 200, body: open };
    return undefined;
  });
  const revoke = await ready();
  await press(revoke.root, "sale-method-qr");
  resetRequests();
  await press(revoke.root, "sale-qr-cancel");
  check(
    "revoke POST sends empty object",
    requests.some(
      (r) =>
        r.path.endsWith("/carts/cart_1/revoke") &&
        r.method === "POST" &&
        JSON.stringify(r.body) === "{}",
    ),
  );

  section("Accessibility");
  const pressables = revoke.root.findAll(
    (node) =>
      node.type === "Pressable" && typeof node.props.onPress === "function",
  );
  const unnamed = pressables.filter(
    (node) =>
      !node.props.accessibilityRole ||
      (!node.props.accessibilityLabel &&
        !String(node.children.join("")).trim()),
  );
  check(
    "every pressable has role and accessible name",
    unnamed.length === 0,
    String(unnamed.length),
  );
  await revoke.unmount();
  setStaffCardBridgeForTests(null);
  finish("sell-to-patient");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
