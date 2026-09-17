import React from "react";
import {
  check,
  finish,
  mount,
  one,
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
  routerLog,
  setSearchParams,
  setPathname,
} from "./provider-training-stubs/expo-router";
import { setStaffCardBridgeForTests } from "../lib/staff-card-bridge";
import {
  setTapToPayBridgeForTests,
  type TapConnectParams,
  type TapResult,
  type TapToPayClient,
} from "../lib/tap-to-pay-bridge";
import SellToPatientScreen from "../app/sell-to-patient";
import type {
  CartCheckoutItem,
  CartCheckoutResponse,
  CartQuote,
  StaffSaleContext,
  TapCancelResponse,
  TapCaptureResponse,
  TapSaleItem,
  TapSaleResponse,
} from "../lib/office-billing-types";

setPathname("/sell-to-patient");
setSearchParams({ patientId: "p1", name: "Ada Lovelace" });

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
  tap_to_pay: { available: true, reason: null },
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
function readyItem(
  order: string,
  kind: TapSaleItem["kind"] = "one_time",
): TapSaleItem {
  return {
    kind,
    order_id: `order_${order}`,
    order_number: `10${order}`,
    subscription_id: kind === "subscription" ? `sub_${order}` : null,
    payment_intent_id: `pi_${order}`,
    client_secret: `pi_${order}_secret`,
    status: "ready",
    error: null,
    total_cents: 5500,
  };
}
function paidItem(item: TapSaleItem): CartCheckoutItem {
  return {
    kind: item.kind,
    order_id: item.order_id,
    order_number: item.order_number,
    subscription_id: item.subscription_id,
    status: "paid",
    client_secret: null,
    error: null,
    total_cents: item.total_cents,
  };
}
function sale(items: TapSaleItem[]): TapSaleResponse {
  return {
    cart_id: "cart_tap",
    items,
    stripe_account_id: "acct_1",
    location_id: "tml_office_1",
    sandbox: true,
  };
}
function checkout(
  items: CartCheckoutItem[],
  status: CartCheckoutResponse["status"] = "paid",
): CartCheckoutResponse {
  return {
    cart_id: "cart_tap",
    status,
    stripe_account_id: "acct_1",
    publishable_key: "pk_test_1",
    sandbox: true,
    items,
  };
}
/** The cancel endpoint's answer: the checkout plus what the server proved about the money. */
function settledAs(
  items: CartCheckoutItem[],
  status: CartCheckoutResponse["status"] = "failed",
): TapCancelResponse {
  const paid = items.filter((item) => item.status === "paid").length;
  return {
    ...checkout(items, status),
    settlement: paid === 0 ? "not_charged" : paid === items.length ? "paid" : "partial",
  };
}
function capture(
  item: TapSaleItem,
  cardOnFile: TapCaptureResponse["card_on_file"],
  all: CartCheckoutItem[],
): TapCaptureResponse {
  return { item: paidItem(item), card_on_file: cardOnFile, checkout: checkout(all) };
}

/** Scripted Terminal client: every call is recorded; collects can be held open. */
function fakeClient(script: {
  connect?: TapResult;
  collects: (TapResult | "hold")[];
}) {
  const calls: { connect: TapConnectParams[]; collect: string[]; cancels: number; disconnects: number } = {
    connect: [],
    collect: [],
    cancels: 0,
    disconnects: 0,
  };
  let held: ((result: TapResult) => void) | null = null;
  const client: TapToPayClient = {
    async connect(params) {
      calls.connect.push(params);
      return script.connect ?? { ok: true };
    },
    collect(secret) {
      calls.collect.push(secret);
      const next = script.collects.shift();
      if (next === "hold")
        return new Promise<TapResult>((resolve) => {
          held = resolve;
        });
      return Promise.resolve(next ?? { ok: true });
    },
    async cancelCollect() {
      calls.cancels += 1;
      held?.({
        ok: false,
        failure: { kind: "canceled", code: "CANCELED", message: "The tap was canceled before the patient tapped." },
      });
      held = null;
    },
    async disconnect() {
      calls.disconnects += 1;
    },
  };
  return { client, calls, release: (result: TapResult) => held?.(result) };
}

type Req = (typeof requests)[number];
function baseScript(
  context: StaffSaleContext = CONTEXT,
  extra?: (req: Req) => { status: number; body: unknown } | undefined,
) {
  setScript((req) => {
    const custom = extra?.(req);
    if (custom) return custom;
    if (req.path === "/api/billing/office/sales/context") return { status: 200, body: context };
    if (req.path === "/api/billing/office/sales/quote") return { status: 200, body: QUOTE };
    return undefined;
  });
}
async function atMethod() {
  const screen = await mount(<SellToPatientScreen />, STAFF);
  await press(screen.root, "sale-select-prod_1");
  await settle(45);
  await press(screen.root, "sale-continue");
  return screen;
}
async function startTap() {
  const screen = await atMethod();
  await press(screen.root, "sale-method-tap");
  resetRequests();
  await press(screen.root, "sale-tap-start");
  return screen;
}
const byPath = (suffix: string) => requests.filter((r) => r.path.endsWith(suffix));

async function main() {
  section("Offer gating");
  resetRequests();
  baseScript();
  setTapToPayBridgeForTests(null);
  const noDevice = await atMethod();
  check(
    "no native Terminal client hides the option even when the office is ready",
    !one(noDevice.root, "sale-method-tap") && !one(noDevice.root, "sale-tap-unavailable"),
  );
  await noDevice.unmount();
  const idle = fakeClient({ collects: [] });
  setTapToPayBridgeForTests(idle.client);
  baseScript({ ...CONTEXT, tap_to_pay: { available: false, reason: "no_office_address" } });
  const noAddress = await atMethod();
  check(
    "server-side reason renders inline instead of the option",
    !one(noAddress.root, "sale-method-tap") &&
      text(noAddress.root, "sale-tap-unavailable").includes("street address"),
    text(noAddress.root, "sale-tap-unavailable"),
  );
  await noAddress.unmount();
  baseScript();
  const offered = await atMethod();
  check(
    "option appears beside card and QR when device and office are ready",
    !!one(offered.root, "sale-method-tap") &&
      !!one(offered.root, "sale-method-card") &&
      !!one(offered.root, "sale-method-qr"),
  );
  await press(offered.root, "sale-method-tap");
  await type(offered.root, "sale-line1", "");
  resetRequests();
  await press(offered.root, "sale-tap-start");
  check(
    "incomplete address blocks the tap sale client-side",
    writes().length === 0 && text(offered.root, "sale-notice").includes("complete shipping address"),
  );
  check("no tap sale means no reader connection", idle.calls.connect.length === 0);
  await offered.unmount();

  section("Single tap paid");
  const oneItem = readyItem("1");
  const single = fakeClient({ collects: [{ ok: true }] });
  setTapToPayBridgeForTests(single.client);
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([oneItem]) };
    if (req.path.endsWith("/sales/tap/cart_tap/capture"))
      return { status: 200, body: capture(oneItem, null, [paidItem(oneItem)]) };
    return undefined;
  });
  const paid = await startTap();
  const tapPost = byPath("/sales/tap")[0];
  check(
    "tap sale body is exact (no payment method, same cart key, the quoted total the button showed)",
    !!tapPost &&
      JSON.stringify(tapPost.body) ===
        JSON.stringify({ patient_id: "p1", lines: LINES, shipping_address: ADDRESS, cart_id: (tapPost.body as any).cart_id, expected_total_cents: 5500 }),
    JSON.stringify(tapPost?.body),
  );
  check(
    "idempotency header matches the cart id",
    !!tapPost?.headers["Idempotency-Key"] && tapPost.headers["Idempotency-Key"] === (tapPost.body as any).cart_id,
  );
  check(
    "reader connects at the office location in the response's mode",
    single.calls.connect.length === 1 &&
      single.calls.connect[0].locationId === "tml_office_1" &&
      single.calls.connect[0].simulated === true,
    JSON.stringify(single.calls.connect),
  );
  check(
    "collect uses the intent's client secret",
    JSON.stringify(single.calls.collect) === JSON.stringify(["pi_1_secret"]),
  );
  const captureReq = byPath("/capture")[0];
  check(
    "capture posts the order id after the tap",
    captureReq?.method === "POST" && JSON.stringify(captureReq.body) === JSON.stringify({ order_id: "order_1" }),
  );
  check(
    "completion renders the paid order",
    !!one(paid.root, "sale-completion") && !!one(paid.root, "sale-order-order_1") && !one(paid.root, "sale-card-on-file"),
  );
  check("nothing was canceled", byPath("/cancel").length === 0);
  await paid.unmount();

  section("Two taps, card on file needed");
  const items = [readyItem("1"), readyItem("2", "subscription")];
  const twice = fakeClient({ collects: ["hold", { ok: true }] });
  setTapToPayBridgeForTests(twice.client);
  let pmCalls = 0;
  setStaffCardBridgeForTests({ createPaymentMethod: async () => `pm_file_${++pmCalls}` });
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale(items) };
    if (req.path.endsWith("/capture")) {
      const id = (req.body as any).order_id;
      const item = items.find((entry) => entry.order_id === id)!;
      const done = items.filter((entry) => entry.order_id <= id).map(paidItem);
      return { status: 200, body: capture(item, item.kind === "subscription" ? "needed" : null, done) };
    }
    if (req.path.endsWith("/card-on-file")) return { status: 200, body: { saved: true } };
    return undefined;
  });
  const multi = await startTap();
  check(
    "first tap shows its position and amount while the phone waits",
    text(multi.root, "sale-tap-collecting").includes("Tap 1 of 2") &&
      text(multi.root, "sale-tap-collecting").includes("$55.00"),
    text(multi.root, "sale-tap-collecting"),
  );
  check("no capture before the tap lands", byPath("/capture").length === 0);
  twice.release({ ok: true });
  await settle(20);
  check(
    "captures run in order, one per tap",
    JSON.stringify(byPath("/capture").map((r) => (r.body as any).order_id)) === JSON.stringify(["order_1", "order_2"]) &&
      JSON.stringify(twice.calls.collect) === JSON.stringify(["pi_1_secret", "pi_2_secret"]),
  );
  check(
    "subscription without a saved card asks for one",
    !!one(multi.root, "sale-card-on-file") && text(multi.root, "sale-card-on-file").includes("102"),
  );
  await press(multi.root, "button-charge-card");
  const onFile = byPath("/card-on-file")[0];
  check(
    "card on file posts subscription and payment method",
    !!onFile && JSON.stringify(onFile.body) === JSON.stringify({ subscription_id: "sub_2", payment_method_id: "pm_file_1" }),
    JSON.stringify(onFile?.body),
  );
  check(
    "saved card lands on completion with both orders",
    !!one(multi.root, "sale-completion") &&
      !!one(multi.root, "sale-order-order_1") &&
      !!one(multi.root, "sale-order-order_2") &&
      text(multi.root, "sale-notice").includes("Card saved"),
  );
  await multi.unmount();

  section("Card on file skipped");
  const skipClient = fakeClient({ collects: [{ ok: true }] });
  setTapToPayBridgeForTests(skipClient.client);
  const subOnly = readyItem("3", "subscription");
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([subOnly]) };
    if (req.path.endsWith("/capture")) return { status: 200, body: capture(subOnly, "needed", [paidItem(subOnly)]) };
    return undefined;
  });
  const skipped = await startTap();
  await press(skipped.root, "sale-card-on-file-skip");
  check(
    "skip goes to completion without posting a card",
    byPath("/card-on-file").length === 0 && !!one(skipped.root, "sale-order-order_3"),
  );
  await skipped.unmount();

  section("Declined tap");
  const declined = fakeClient({
    collects: [{ ok: false, failure: { kind: "declined", code: "DECLINED_BY_STRIPE_API", message: "The card was declined: insufficient funds." } }],
  });
  setTapToPayBridgeForTests(declined.client);
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([readyItem("1")]) };
    if (req.path.endsWith("/cancel")) return { status: 200, body: settledAs([{ ...paidItem(readyItem("1")), status: "failed", error: "declined" }]) };
    return undefined;
  });
  const decl = await startTap();
  const cancelReq = byPath("/cancel")[0];
  check(
    "declined tap is reported to the server with its reason",
    !!cancelReq &&
      JSON.stringify(cancelReq.body) ===
        JSON.stringify({ reason: "declined", message: "The card was declined: insufficient funds." }),
    JSON.stringify(cancelReq?.body),
  );
  check(
    "decline shows inline with retry and both fallbacks",
    text(decl.root, "sale-tap-failure").includes("insufficient funds") &&
      !!one(decl.root, "sale-tap-retry") &&
      !!one(decl.root, "sale-tap-fallback-card") &&
      !!one(decl.root, "sale-tap-fallback-qr"),
  );
  check("no capture attempted after a decline", byPath("/capture").length === 0);
  const firstKey = byPath("/sales/tap")[0].headers["Idempotency-Key"];
  declined.client.collect = async () => ({ ok: true });
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([readyItem("1")]) };
    if (req.path.endsWith("/capture")) return { status: 200, body: capture(readyItem("1"), null, [paidItem(readyItem("1"))]) };
    return undefined;
  });
  await press(decl.root, "sale-tap-retry");
  const retryKeys = byPath("/sales/tap").map((r) => r.headers["Idempotency-Key"]);
  check(
    "retry mints a new cart key and completes",
    retryKeys.length === 2 && retryKeys[1] !== firstKey && !!one(decl.root, "sale-completion"),
  );
  await decl.unmount();

  section("Lost capture: nothing may collect again until the server answers");
  const lost = fakeClient({ collects: [{ ok: true }] });
  setTapToPayBridgeForTests(lost.client);
  let cancelAnswer: "network-error" | "paid" | "failed" = "network-error";
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([readyItem("1")]) };
    if (req.path.endsWith("/capture")) return "network-error";
    if (req.path.endsWith("/cancel")) {
      if (cancelAnswer === "network-error") return "network-error";
      if (cancelAnswer === "paid") return { status: 200, body: settledAs([paidItem(readyItem("1"))], "paid") };
      return { status: 200, body: settledAs([{ ...paidItem(readyItem("1")), status: "failed", error: "Voided." }]) };
    }
    return undefined;
  });
  const unsettled = await startTap();
  check(
    "a tap whose capture and cancel replies were both lost is shown as unconfirmed",
    !!one(unsettled.root, "sale-tap-failed") && !!one(unsettled.root, "sale-tap-unsettled") && !!one(unsettled.root, "sale-tap-settle"),
  );
  check(
    "no retry or fallback is offered while the outcome is unknown",
    !one(unsettled.root, "sale-tap-retry") && !one(unsettled.root, "sale-tap-fallback-card") && !one(unsettled.root, "sale-tap-fallback-qr"),
  );
  check("the settle attempt reached the cancel endpoint once", byPath("/cancel").length === 1 && byPath("/sales/tap").length === 1);
  await press(unsettled.root, "sale-tap-settle");
  check(
    "asking again stays on the same cart key and stays locked while the answer is still lost",
    byPath("/cancel").length === 2 && byPath("/sales/tap").length === 1 && !!one(unsettled.root, "sale-tap-settle") && !one(unsettled.root, "sale-tap-fallback-card"),
  );
  cancelAnswer = "paid";
  await press(unsettled.root, "sale-tap-settle");
  check(
    "a paid answer completes the original sale instead of charging again",
    !!one(unsettled.root, "sale-completion") && !!one(unsettled.root, "sale-order-order_1") && byPath("/sales/tap").length === 1,
  );
  await unsettled.unmount();

  const voided = fakeClient({ collects: [{ ok: true }] });
  setTapToPayBridgeForTests(voided.client);
  cancelAnswer = "network-error";
  const locked = await startTap();
  check("second lost tap starts locked too", !!one(locked.root, "sale-tap-settle") && !one(locked.root, "sale-tap-retry"));
  cancelAnswer = "failed";
  await press(locked.root, "sale-tap-settle");
  check(
    "a definite not-charged answer unlocks retry and both fallbacks",
    !one(locked.root, "sale-tap-settle") && !!one(locked.root, "sale-tap-retry") && !!one(locked.root, "sale-tap-fallback-card") && !!one(locked.root, "sale-tap-fallback-qr"),
  );
  await locked.unmount();

  section("Only an explicit not_charged unlocks; the lock survives closing the screen");
  const refused = fakeClient({ collects: [{ ok: true }] });
  setTapToPayBridgeForTests(refused.client);
  let refusal: { status: number; body: unknown } | "network-error" = { status: 409, body: { error: "A tap payment for this sale already went through. Contact your office to finish it.", reason: "manual_resolution" } };
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([readyItem("1")]) };
    if (req.path.endsWith("/capture")) return "network-error";
    if (req.path.endsWith("/cancel")) return refusal;
    return undefined;
  });
  const manual = await startTap();
  check(
    "a 409 manual_resolution answer keeps the lock and explains that staff must finish the sale",
    !!one(manual.root, "sale-tap-settle") && !one(manual.root, "sale-tap-retry") && !one(manual.root, "sale-tap-fallback-card") && !one(manual.root, "sale-tap-fallback-qr") &&
      text(manual.root, "sale-tap-manual").includes("already went through") && text(manual.root, "sale-tap-manual").includes("Do not take another payment"),
  );
  refusal = { status: 409, body: { error: "That sale was not found." } };
  await press(manual.root, "sale-tap-settle");
  check(
    "any other 4xx keeps the lock too: only not_charged is proof",
    !!one(manual.root, "sale-tap-settle") && !one(manual.root, "sale-tap-retry") && !one(manual.root, "sale-tap-fallback-card") && text(manual.root, "sale-tap-unsettled").includes("not found"),
  );
  refusal = { status: 503, body: { error: "Stripe could not confirm what happened to the tap yet.", reason: "settlement_unknown" } };
  await press(manual.root, "sale-tap-settle");
  check("settlement_unknown stays locked and asks again", !!one(manual.root, "sale-tap-settle") && !one(manual.root, "sale-tap-retry"));
  const backsBefore = routerLog.filter((call) => call.method === "back").length;
  await press(manual.root, "sale-close");
  check("closing the screen is refused while the outcome is unknown", routerLog.filter((call) => call.method === "back").length === backsBefore);
  const lockedCart = (byPath("/cancel")[0]?.path ?? "").split("/tap/")[1]?.split("/")[0] ?? "";
  await manual.unmount();

  // The provider force-quit or backed out: the key must come back, for this
  // patient as the same locked sale, for anyone else as a block.
  setTapToPayBridgeForTests(fakeClient({ collects: [] }).client);
  resetRequests();
  const restored = await mount(<SellToPatientScreen />, STAFF);
  await settle(45);
  check(
    "reopening the same patient restores the unsettled sale under its own cart key and asks the server at once",
    !!one(restored.root, "sale-tap-settle") && !one(restored.root, "sale-select-prod_1") && byPath("/cancel").length === 1 &&
      byPath("/cancel")[0]!.path.includes(`/tap/${lockedCart}/`) && byPath("/sales/tap").length === 0,
    JSON.stringify({ lockedCart, cancels: byPath("/cancel").map((r) => r.path) }),
  );
  await restored.unmount();
  setSearchParams({ patientId: "p2", name: "Grace Hopper" });
  resetRequests();
  const other = await mount(<SellToPatientScreen />, STAFF);
  await settle(45);
  check(
    "another patient's sale is blocked until the held tap is confirmed",
    !!one(other.root, "sale-tap-held") && text(other.root, "sale-tap-held-copy").includes("Ada Lovelace") && !one(other.root, "sale-select-prod_1") && byPath("/cancel").length === 0,
  );
  const replacesBefore = routerLog.filter((call) => call.method === "replace").length;
  await press(other.root, "sale-tap-held-open");
  check(
    "the block links back to the held sale",
    routerLog.filter((call) => call.method === "replace").length === replacesBefore + 1 && JSON.stringify(routerLog[routerLog.length - 1]).includes("p1"),
    JSON.stringify(routerLog[routerLog.length - 1]),
  );
  await other.unmount();
  setSearchParams({ patientId: "p1", name: "Ada Lovelace" });
  refusal = { status: 200, body: settledAs([{ ...paidItem(readyItem("1")), status: "failed", error: "Voided." }]) };
  resetRequests();
  const released = await mount(<SellToPatientScreen />, STAFF);
  await settle(45);
  check(
    "a not_charged answer on reopen frees the phone again",
    byPath("/cancel").length === 1 && !!one(released.root, "sale-tap-retry") && !!one(released.root, "sale-tap-fallback-card") && !one(released.root, "sale-tap-settle"),
  );
  await released.unmount();
  setSearchParams({ patientId: "p2", name: "Grace Hopper" });
  const freed = await mount(<SellToPatientScreen />, STAFF);
  await settle(45);
  check("once settled, nothing is held any more", !one(freed.root, "sale-tap-held") && !!one(freed.root, "sale-select-prod_1"));
  await freed.unmount();
  setSearchParams({ patientId: "p1", name: "Ada Lovelace" });

  section("Unsupported device falls back");
  const unsupported = fakeClient({
    connect: { ok: false, failure: { kind: "unsupported", code: "TAP_TO_PAY_LIBRARY_NOT_INCLUDED", message: "This build of THINNR is not entitled for Tap to Pay yet. Use the card form or QR code." } },
    collects: [],
  });
  setTapToPayBridgeForTests(unsupported.client);
  setStaffCardBridgeForTests({ createPaymentMethod: async () => "pm_x" });
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale([readyItem("1")]) };
    if (req.path.endsWith("/cancel")) return { status: 200, body: settledAs([]) };
    return undefined;
  });
  const unsup = await startTap();
  check(
    "unsupported reports fallback and hides retry",
    JSON.stringify((byPath("/cancel")[0]?.body as any)?.reason) === JSON.stringify("fallback") &&
      !one(unsup.root, "sale-tap-retry") &&
      text(unsup.root, "sale-tap-failure").includes("not entitled"),
  );
  check("unsupported never collects", unsupported.calls.collect.length === 0);
  await press(unsup.root, "sale-tap-fallback-card");
  check(
    "card fallback shows the card form with the address",
    !!one(unsup.root, "button-charge-card") && !!one(unsup.root, "sale-line1"),
  );
  await unsup.unmount();

  section("Tap sale rejected by the server");
  const rejected = fakeClient({ collects: [] });
  setTapToPayBridgeForTests(rejected.client);
  baseScript(CONTEXT, (req) =>
    req.path.endsWith("/sales/tap") ? { status: 402, body: { error: "Stripe would not open a tap for this order." } } : undefined,
  );
  const rej = await startTap();
  check(
    "402 shows the server message with fallbacks and no cancel call",
    text(rej.root, "sale-tap-failure").includes("would not open a tap") &&
      byPath("/cancel").length === 0 &&
      rejected.calls.connect.length === 0 &&
      !!one(rej.root, "sale-tap-fallback-qr"),
  );
  await rej.unmount();

  section("Canceled mid-tap and partial settlement");
  const partialItems = [readyItem("1"), readyItem("2")];
  const partial = fakeClient({ collects: [{ ok: true }, "hold"] });
  setTapToPayBridgeForTests(partial.client);
  baseScript(CONTEXT, (req) => {
    if (req.path.endsWith("/sales/tap")) return { status: 200, body: sale(partialItems) };
    if (req.path.endsWith("/capture")) return { status: 200, body: capture(partialItems[0], null, [paidItem(partialItems[0])]) };
    if (req.path.endsWith("/cancel"))
      return { status: 200, body: settledAs([paidItem(partialItems[0]), { ...paidItem(partialItems[1]), status: "failed", error: "canceled" }], "partial") };
    return undefined;
  });
  const part = await startTap();
  check("second tap is waiting", text(part.root, "sale-tap-collecting").includes("Tap 2 of 2"));
  await press(part.root, "sale-tap-cancel");
  check(
    "cancel button dismisses the tap and reports canceled",
    partial.calls.cancels === 1 && (byPath("/cancel")[0]?.body as any)?.reason === "canceled",
    JSON.stringify(byPath("/cancel")[0]?.body),
  );
  check(
    "already-paid order shows on completion with the failure notice",
    !!one(part.root, "sale-order-order_1") &&
      !!one(part.root, "sale-completion") &&
      text(part.root, "sale-notice").includes("canceled"),
  );

  section("Accessibility");
  const pressables = part.root.findAll(
    (node) => node.type === "Pressable" && typeof node.props.onPress === "function",
  );
  const unnamed = pressables.filter(
    (node) => !node.props.accessibilityRole || (!node.props.accessibilityLabel && !String(node.children.join("")).trim()),
  );
  check("every pressable has role and accessible name", unnamed.length === 0, String(unnamed.length));
  await part.unmount();
  setTapToPayBridgeForTests(null);
  setStaffCardBridgeForTests(null);
  finish("tap-to-pay");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
