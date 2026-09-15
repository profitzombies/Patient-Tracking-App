/**
 * Seed realistic SANDBOX sales for the connected test office.
 *
 * Every order goes through the real public checkout (link → order → Stripe
 * PaymentIntent confirmed with a test card on the connected account), so the
 * webhooks, ledger, receipts and dashboards see exactly what a real sale
 * produces. Refunds are created on the connected account and reconciled by
 * the `charge.refunded` webhook like any office-initiated refund.
 *
 *   tsx scripts/seed-test-sales.mts now    [--count 6]
 *   tsx scripts/seed-test-sales.mts plan   [--hours 24] [--target-dollars 2500] [--refunds 3]
 *   tsx scripts/seed-test-sales.mts run              # executes the plan; safe to restart (resumable)
 *   tsx scripts/seed-test-sales.mts status
 *
 * Refuses to run against a live-mode account or a live Stripe key.
 * State lives in .local/state/test-sales-plan.json (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { publicOrigin } from "../src/billing/app-origin";
import { connectedOpts, getStripe, getStripeCredentials } from "../src/billing/stripe-client";
import { selectMany, selectOne } from "../src/billing/store";
import type { PublicLink, PublicOrderResponse, PublicOrderStatus } from "../src/billing/types";

const PLAN_PATH = resolve(process.cwd(), "../../.local/state/test-sales-plan.json");
const DAY_START_HOUR = 8;   // ET, inclusive
const DAY_END_HOUR = 21;    // ET, exclusive
const TIME_ZONE = "America/New_York";

interface Payer { name: string; email: string; phone: string; line1: string; city: string; state: string; postal_code: string }
const PAYERS: Payer[] = [
  { name: "Maria Delgado", email: "maria.delgado@example.com", phone: "+13055550141", line1: "1180 Brickell Bay Dr", city: "Miami", state: "FL", postal_code: "33131" },
  { name: "James Whitfield", email: "james.whitfield@example.com", phone: "+14045550182", line1: "77 Peachtree Pl NE", city: "Atlanta", state: "GA", postal_code: "30309" },
  { name: "Priya Natarajan", email: "priya.natarajan@example.com", phone: "+19725550117", line1: "4200 McKinney Ave", city: "Dallas", state: "TX", postal_code: "75205" },
  { name: "Daniel Okafor", email: "daniel.okafor@example.com", phone: "+17045550163", line1: "300 S Tryon St", city: "Charlotte", state: "NC", postal_code: "28202" },
  { name: "Hannah Lindqvist", email: "hannah.lindqvist@example.com", phone: "+16125550128", line1: "900 Nicollet Mall", city: "Minneapolis", state: "MN", postal_code: "55402" },
  { name: "Tom Brennan", email: "tom.brennan@example.com", phone: "+16175550194", line1: "45 Province St", city: "Boston", state: "MA", postal_code: "02108" },
  { name: "Aisha Rahman", email: "aisha.rahman@example.com", phone: "+13125550176", line1: "233 S Wacker Dr", city: "Chicago", state: "IL", postal_code: "60606" },
  { name: "Luis Herrera", email: "luis.herrera@example.com", phone: "+16025550139", line1: "2 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004" },
  { name: "Grace Kim", email: "grace.kim@example.com", phone: "+12065550152", line1: "400 Pine St", city: "Seattle", state: "WA", postal_code: "98101" },
  { name: "Robert Feld", email: "robert.feld@example.com", phone: "+13035550187", line1: "1700 Lincoln St", city: "Denver", state: "CO", postal_code: "80203" },
  { name: "Sofia Marchetti", email: "sofia.marchetti@example.com", phone: "+12155550125", line1: "1500 Market St", city: "Philadelphia", state: "PA", postal_code: "19102" },
  { name: "Kevin O'Neal", email: "kevin.oneal@example.com", phone: "+16155550168", line1: "150 3rd Ave S", city: "Nashville", state: "TN", postal_code: "37201" },
];

interface OrderEvent { kind: "order"; at: string; payer: number; items: Array<{ product_id: string; quantity: number }>; expected_cents: number;
  fired_at?: string; order_id?: string; order_number?: string; payment_intent_id?: string; error?: string }
interface RefundEvent { kind: "refund"; at: string; order_index: number; fraction: number; fired_at?: string; refund_id?: string; amount_cents?: number; error?: string }
type PlanEvent = OrderEvent | RefundEvent;
interface Plan { created_at: string; token: string; stripe_account_id: string; events: PlanEvent[] }

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`--${name} needs a number`);
  return value;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
function hourInEt(date: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hour12: false }).format(date)) % 24;
}
function loadPlan(): Plan {
  if (!existsSync(PLAN_PATH)) throw new Error(`No plan at ${PLAN_PATH}; run "plan" first.`);
  return JSON.parse(readFileSync(PLAN_PATH, "utf8")) as Plan;
}
function savePlan(plan: Plan): void {
  mkdirSync(dirname(PLAN_PATH), { recursive: true });
  writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2));
}

async function context() {
  const credentials = await getStripeCredentials();
  if (!credentials.publishable.startsWith("pk_test_")) throw new Error("Refusing: the Stripe connection is not a sandbox key.");
  const account = await selectOne("billing_connected_accounts", "charges_enabled=eq.true&disconnected_at=is.null&livemode=eq.false");
  if (!account) throw new Error("No sandbox connected account with charges enabled.");
  const links = await selectMany("billing_payment_links", `provider_id=eq.${encodeURIComponent(account.provider_id)}&active=eq.true&patient_id=is.null&product_id=is.null&expires_at=is.null&order=created_at.asc`);
  const link = links[0];
  if (!link) throw new Error("The office has no generic active payment link.");
  const origin = publicOrigin();
  const linkResponse = await fetch(`${origin}/api/billing/public/links/${link.token}`);
  if (!linkResponse.ok) throw new Error(`Link lookup failed (${linkResponse.status}) at ${origin}`);
  const offering = await linkResponse.json() as PublicLink;
  if (!offering.sandbox) throw new Error("Refusing: checkout reports live mode.");
  return { origin, token: link.token, account, offering, stripe: await getStripe() };
}
type Ctx = Awaited<ReturnType<typeof context>>;

function randomOrder(ctx: Ctx, at: Date): OrderEvent {
  const products = ctx.offering.products;
  const first = pick(products);
  const items = [{ product_id: first.product_id, quantity: Math.random() < 0.25 ? 2 : 1 }];
  if (Math.random() < 0.3) {
    const second = pick(products.filter((product) => product.product_id !== first.product_id));
    if (second) items.push({ product_id: second.product_id, quantity: 1 });
  }
  const subtotal = items.reduce((sum, item) => sum + (products.find((product) => product.product_id === item.product_id)?.unit_price_cents ?? 0) * item.quantity, 0);
  return { kind: "order", at: at.toISOString(), payer: Math.floor(Math.random() * PAYERS.length), items, expected_cents: subtotal + ctx.offering.shipping_charge_cents };
}

async function placeOrder(ctx: Ctx, event: OrderEvent): Promise<void> {
  const payer = PAYERS[event.payer];
  const response = await fetch(`${ctx.origin}/api/billing/public/links/${ctx.token}/orders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: event.items, purchase: "one_time",
      payer: { name: payer.name, email: payer.email, phone: payer.phone },
      shipping_address: { name: payer.name, line1: payer.line1, line2: null, city: payer.city, state: payer.state, postal_code: payer.postal_code, country: "US", phone: payer.phone },
    }),
  });
  const body = await response.json() as PublicOrderResponse & { error?: string };
  if (!response.ok) throw new Error(`order create ${response.status}: ${body.error ?? "unknown"}`);
  const paymentIntentId = body.client_secret.split("_secret_")[0];
  const intent = await ctx.stripe.paymentIntents.confirm(paymentIntentId, { payment_method: "pm_card_visa" }, connectedOpts(ctx.account.stripe_account_id));
  if (intent.livemode) throw new Error("Refusing: PaymentIntent is live mode.");
  event.order_id = body.order_id; event.order_number = body.order_number; event.payment_intent_id = paymentIntentId; event.fired_at = new Date().toISOString();
  console.log(`[order] ${body.order_number} ${money(body.totals.total_cents)} ${payer.name} → ${intent.status}`);
}

async function waitPaid(ctx: Ctx, orderId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`${ctx.origin}/api/billing/public/orders/${orderId}/status?token=${ctx.token}`);
    if (response.ok) {
      const status = (await response.json() as PublicOrderStatus).status;
      if (status === "paid") return true;
      if (status !== "pending") return false;
    }
    await sleep(5000);
  }
  return false;
}

async function refundOrder(ctx: Ctx, plan: Plan, event: RefundEvent): Promise<void> {
  const target = plan.events[event.order_index];
  if (target.kind !== "order" || !target.payment_intent_id || !target.order_id) throw new Error("refund target has no payment");
  if (!(await waitPaid(ctx, target.order_id))) throw new Error(`order ${target.order_number} never reached paid`);
  const intent = await ctx.stripe.paymentIntents.retrieve(target.payment_intent_id, {}, connectedOpts(ctx.account.stripe_account_id));
  const amount = event.fraction >= 1 ? intent.amount : Math.max(100, Math.round(intent.amount * event.fraction));
  const refund = await ctx.stripe.refunds.create(
    { payment_intent: target.payment_intent_id, amount, reason: "requested_by_customer", metadata: { requested_reason: event.fraction >= 1 ? "Returned unopened" : "One item returned" } },
    connectedOpts(ctx.account.stripe_account_id, `test-seed:refund:${plan.created_at}:${event.order_index}`),
  );
  event.refund_id = refund.id; event.amount_cents = amount; event.fired_at = new Date().toISOString();
  console.log(`[refund] ${target.order_number} ${money(amount)} (${event.fraction >= 1 ? "full" : "partial"}) → ${refund.status}`);
}

async function fire(ctx: Ctx, plan: Plan, event: PlanEvent): Promise<void> {
  try {
    if (event.kind === "order") await placeOrder(ctx, event); else await refundOrder(ctx, plan, event);
  } catch (error) {
    event.error = error instanceof Error ? error.message : String(error);
    event.fired_at = new Date().toISOString();
    console.error(`[${event.kind}] failed: ${event.error}`);
  }
  savePlan(plan);
}

async function commandNow(): Promise<void> {
  const ctx = await context();
  const count = arg("count", 6);
  const plan: Plan = { created_at: new Date().toISOString(), token: ctx.token, stripe_account_id: ctx.account.stripe_account_id, events: [] };
  for (let index = 0; index < count; index++) plan.events.push(randomOrder(ctx, new Date()));
  let total = 0;
  for (const event of plan.events) {
    await fire(ctx, plan, event);
    if (event.kind === "order" && !event.error) total += event.expected_cents;
    await sleep(3000); // stay under the public order limiter
  }
  console.log(`Placed ${plan.events.filter((event) => !event.error).length}/${count} orders, ${money(total)} expected. Webhooks mark them paid within ~10 s.`);
}

async function commandPlan(): Promise<void> {
  const ctx = await context();
  const hours = arg("hours", 24);
  const target = Math.round(arg("target-dollars", 2500) * 100);
  const refunds = arg("refunds", 3);
  const start = Date.now() + 5 * 60_000;
  const end = Date.now() + hours * 3_600_000;
  const events: OrderEvent[] = [];
  let total = 0;
  while (total < target && events.length < 60) {
    let at = new Date(start + Math.random() * (end - start));
    for (let tries = 0; tries < 8 && (hourInEt(at) < DAY_START_HOUR || hourInEt(at) >= DAY_END_HOUR); tries++) at = new Date(start + Math.random() * (end - start));
    const event = randomOrder(ctx, at);
    events.push(event); total += event.expected_cents;
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  const plan: Plan = { created_at: new Date().toISOString(), token: ctx.token, stripe_account_id: ctx.account.stripe_account_id, events: [...events] };
  // Refund a few of the earlier orders 20–90 minutes after they were paid.
  const candidates = events.slice(0, Math.max(refunds, Math.floor(events.length * 0.6))).map((event) => plan.events.indexOf(event));
  const chosen = new Set<number>();
  while (chosen.size < Math.min(refunds, candidates.length)) chosen.add(pick(candidates));
  [...chosen].forEach((orderIndex, position) => {
    const order = plan.events[orderIndex] as OrderEvent;
    const at = new Date(new Date(order.at).getTime() + (20 + Math.random() * 70) * 60_000).toISOString();
    plan.events.push({ kind: "refund", at, order_index: orderIndex, fraction: position === 0 ? 1 : 0.5 });
  });
  savePlan(plan);
  console.log(`Planned ${events.length} orders (${money(total)}) and ${chosen.size} refunds over the next ${hours} h. Saved to ${PLAN_PATH}.`);
  for (const event of [...plan.events].sort((a, b) => a.at.localeCompare(b.at))) {
    const when = new Date(event.at).toLocaleString("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    console.log(`  ${when}  ${event.kind === "order" ? `${money(event.expected_cents)} ${PAYERS[event.payer].name}` : `refund of order #${event.order_index + 1} (${event.fraction >= 1 ? "full" : "half"})`}`);
  }
}

async function commandRun(): Promise<void> {
  const plan = loadPlan();
  const ctx = await context();
  if (ctx.account.stripe_account_id !== plan.stripe_account_id) throw new Error("Plan was made for a different connected account.");
  console.log(`Running plan from ${plan.created_at}: ${plan.events.filter((event) => !event.fired_at).length} events pending.`);
  for (;;) {
    const pending = plan.events.filter((event) => !event.fired_at).sort((a, b) => a.at.localeCompare(b.at));
    // Refunds wait for their order; never fire a refund whose order is still pending.
    const next = pending.find((event) => event.kind === "order" || Boolean((plan.events[event.order_index] as OrderEvent).fired_at) || Boolean((plan.events[event.order_index] as OrderEvent).error));
    if (!next) { console.log("Plan complete."); return; }
    const wait = new Date(next.at).getTime() - Date.now();
    if (wait > 0) {
      console.log(`Next: ${next.kind} at ${new Date(next.at).toLocaleString("en-US", { timeZone: TIME_ZONE })} (in ${Math.round(wait / 60_000)} min)`);
      await sleep(Math.min(wait, 15 * 60_000));
      continue;
    }
    if (next.kind === "refund" && (plan.events[next.order_index] as OrderEvent).error) {
      next.error = "order failed"; next.fired_at = new Date().toISOString(); savePlan(plan); continue;
    }
    await fire(ctx, plan, next);
    await sleep(3000);
  }
}

function commandStatus(): void {
  const plan = loadPlan();
  const orders = plan.events.filter((event): event is OrderEvent => event.kind === "order");
  const done = orders.filter((event) => event.fired_at && !event.error);
  console.log(`Orders: ${done.length}/${orders.length} placed (${money(done.reduce((sum, event) => sum + event.expected_cents, 0))} of ${money(orders.reduce((sum, event) => sum + event.expected_cents, 0))}).`);
  const refunds = plan.events.filter((event): event is RefundEvent => event.kind === "refund");
  console.log(`Refunds: ${refunds.filter((event) => event.fired_at && !event.error).length}/${refunds.length} issued.`);
  for (const event of plan.events.filter((item) => item.error)) console.log(`  failed ${event.kind} at ${event.at}: ${event.error}`);
  const next = plan.events.filter((event) => !event.fired_at).sort((a, b) => a.at.localeCompare(b.at))[0];
  if (next) console.log(`Next ${next.kind}: ${new Date(next.at).toLocaleString("en-US", { timeZone: TIME_ZONE })}`);
}

const command = process.argv[2];
const run = command === "now" ? commandNow() : command === "plan" ? commandPlan() : command === "run" ? commandRun() : command === "status" ? Promise.resolve(commandStatus()) : Promise.reject(new Error("usage: seed-test-sales.mts now|plan|run|status"));
run.then(() => process.exit(0)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
