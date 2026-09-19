/**
 * Synthetic-only live proof harness for the signed-in Overview finance tiles
 * (MRR tile, Revenue Trend, "Failed Subscription Payments" priority card).
 *
 * Mints ONE throwaway office with a real Stripe TEST connected account, an
 * owner and a non-owner staff member, and billing_subscriptions rows in every
 * status the tiles care about (active × 3 with differing quantity/cadence,
 * past_due, unpaid, plus canceled + incomplete controls) together with paid
 * orders placed so the Revenue Trend delta differs between the default 30-day
 * range and a 7-day range.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/overview-finance-live-smoke.ts prepare
 *   pnpm --filter @workspace/api-server exec tsx scripts/overview-finance-live-smoke.ts helper
 *   OVERVIEW_SMOKE_API_BASE_URL=http://127.0.0.1:3000/api \
 *     pnpm --filter @workspace/api-server exec tsx scripts/overview-finance-live-smoke.ts verify [--keep]
 *   pnpm --filter @workspace/api-server exec tsx scripts/overview-finance-live-smoke.ts expected
 *   pnpm --filter @workspace/api-server exec tsx scripts/overview-finance-live-smoke.ts cleanup
 *
 * `verify` proves the API half of the chain (owner dashboard figures, the
 * needs_attention list, the staff 403, the prior-window series) and, unless
 * --keep is given, tears the fixture down. `helper` writes the temporary
 * session pages the browser tester opens (never paste tokens into a tester).
 *
 * Refuses to run when the Stripe connection is not a sandbox key. Passwords,
 * sessions, and helper contents are written only to mode-0600 files; output
 * is limited to synthetic ids, expected figures, and random route paths.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getStripe, isSandbox } from "../src/billing/stripe-client";
import { monthlyRecurringRevenueCents, needsAttentionSubscriptionCount } from "../src/billing/reporting";

const FIXTURE_PATH = "/tmp/thinnr-overview-finance-fixture.json";
const DEFAULT_API_BASE = "http://127.0.0.1:3000/api";
const HELPER_ROOT = resolve(process.cwd(), "../../tmp");
const WEB_PUBLIC = resolve(process.cwd(), "../thinnr-operations/public");
const EXCLUDE_PATH = resolve(process.cwd(), "../../.git/info/exclude");

const roles = ["owner", "staff"] as const;
type Role = typeof roles[number];
type SubscriptionStatus = "active" | "past_due" | "unpaid" | "canceled" | "incomplete";

interface StoredIdentity { userId: string; email: string; password: string; session: Record<string, unknown> }
interface SeedSubscription {
  id: string; label: string; status: SubscriptionStatus; unit_price_cents: number; quantity: number; cadence_weeks: number;
}
interface SeedOrder { id: string; daysAgo: number; total_cents: number }
interface FixtureState {
  version: 1;
  runId: string;
  createdAt: string;
  apiBase: string;
  /** UTC calendar day the fixture was seeded against (YYYY-MM-DD). */
  todayKey: string;
  providerId: string;
  stripeAccountId: string | null;
  productIds: string[];
  payerIds: string[];
  subscriptions: SeedSubscription[];
  orders: SeedOrder[];
  identities: Partial<Record<Role, StoredIdentity>>;
  teamMemberId: string;
  helper: { directory: string; route: string; files: Partial<Record<Role, string>> };
}

/** The seeded plan. Yearly cents are summed first and divided once (see reporting.ts). */
const SUBSCRIPTION_PLAN: Array<Omit<SeedSubscription, "id">> = [
  { label: "active 4wk x1", status: "active", unit_price_cents: 5999, quantity: 1, cadence_weeks: 4 },
  { label: "active 6wk x2", status: "active", unit_price_cents: 8999, quantity: 2, cadence_weeks: 6 },
  { label: "active 12wk x1", status: "active", unit_price_cents: 2999, quantity: 1, cadence_weeks: 12 },
  { label: "past_due", status: "past_due", unit_price_cents: 5999, quantity: 1, cadence_weeks: 4 },
  { label: "unpaid", status: "unpaid", unit_price_cents: 8999, quantity: 1, cadence_weeks: 4 },
  { label: "canceled control", status: "canceled", unit_price_cents: 5999, quantity: 3, cadence_weeks: 2 },
  { label: "incomplete control", status: "incomplete", unit_price_cents: 8999, quantity: 1, cadence_weeks: 4 },
];
/**
 * Paid orders relative to today (UTC noon). Default live range = last 30 days
 * (today-29..today) with prior window today-59..today-30; a 7-day range
 * (today-6..today) has prior window today-13..today-7.
 */
const ORDER_PLAN: Array<Omit<SeedOrder, "id">> = [
  { daysAgo: 3, total_cents: 20000 },   // in both ranges
  { daysAgo: 10, total_cents: 15000 },  // in the 30-day range; prior window of the 7-day range
  { daysAgo: 45, total_cents: 30000 },  // prior window of the 30-day range only
];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value.replace(/\/$/, "");
}
function credentials() {
  return {
    url: requireEnv("SUPABASE_URL"),
    service: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    anon: requireEnv("SUPABASE_ANON_KEY"),
    management: process.env.SUPABASE_ACCESS_TOKEN?.trim() || null,
  };
}
function safeRemoteMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "remote request failed";
  for (const key of ["message", "error_description", "error", "code"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") return value.slice(0, 200);
  }
  return "remote request failed";
}
async function request(url: string, init: RequestInit, expected = [200]): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!expected.includes(response.status)) throw new Error(`Request returned ${response.status}: ${safeRemoteMessage(body)}`);
  return { status: response.status, body };
}
async function serviceRest(method: string, path: string, body?: unknown, expected = [200, 201, 204], prefer?: string) {
  const { url, service } = credentials();
  return request(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json",
      Prefer: prefer ?? (method === "POST" ? "return=representation" : "return=minimal"),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, expected);
}
async function managementQuery(query: string): Promise<any> {
  const { url, management } = credentials();
  if (!management) throw new Error("SUPABASE_ACCESS_TOKEN is required (order seeding and atomic cleanup).");
  const ref = new URL(url).hostname.split(".")[0];
  return (await request(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${management}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }, [200, 201])).body;
}
const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
  console.log(`ok - ${label}`);
}

async function saveState(state: FixtureState) {
  await writeFile(FIXTURE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(FIXTURE_PATH, 0o600);
}
async function loadState(): Promise<FixtureState> {
  const state = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureState;
  if (state.version !== 1 || !state.providerId) throw new Error("The overview finance fixture file is invalid.");
  const mode = (await stat(FIXTURE_PATH)).mode & 0o777;
  if (mode !== 0o600) throw new Error("Fixture permissions are not 0600.");
  return state;
}
function identity(state: FixtureState, role: Role): StoredIdentity {
  const found = state.identities[role];
  if (!found) throw new Error(`Fixture has no ${role} identity.`);
  return found;
}

async function createAuthUser(email: string, password: string, displayName: string): Promise<string> {
  const { url, service } = credentials();
  const result = await request(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { thinnr_claim: "overview-finance-live-smoke" },
      user_metadata: { display_name: displayName },
    }),
  }, [200, 201]);
  if (typeof result.body?.id !== "string") throw new Error("Auth user creation returned no id.");
  return result.body.id;
}
async function deleteAuthUser(userId: string): Promise<void> {
  const { url, service } = credentials();
  await request(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE", headers: { apikey: service, Authorization: `Bearer ${service}` },
  }, [200, 204, 404]);
}
async function authUserAbsent(userId: string): Promise<boolean> {
  const { url, service } = credentials();
  const result = await request(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "GET", headers: { apikey: service, Authorization: `Bearer ${service}` },
  }, [200, 404]);
  return result.status === 404;
}
async function signIn(email: string, password: string): Promise<Record<string, unknown>> {
  const { url, anon } = credentials();
  const result = await request(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (typeof result.body?.access_token !== "string") throw new Error("Synthetic sign-in returned no session.");
  return result.body as Record<string, unknown>;
}

function utcTodayKey(): string { return new Date().toISOString().slice(0, 10); }
function addDays(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
/** Same display rule as the Overview's formatMoney (dollars). */
function formatMoney(dollars: number): string {
  return dollars >= 1000 ? `$${(dollars / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(dollars)}`;
}

/** Expected figures derived from the seeded plan with the documented formula (independent of reporting.ts). */
function expectedFigures(state: FixtureState) {
  const yearly = state.subscriptions.filter((row) => row.status === "active")
    .reduce((sum, row) => sum + (row.unit_price_cents * row.quantity * 52) / row.cadence_weeks, 0);
  const mrrCents = Math.round(yearly / 12);
  const active = state.subscriptions.filter((row) => row.status === "active").length;
  const failedRows = state.subscriptions.filter((row) => row.status === "past_due" || row.status === "unpaid");
  const totalIn = (startAgo: number, endAgo: number) => state.orders
    .filter((row) => row.daysAgo <= startAgo && row.daysAgo >= endAgo).reduce((sum, row) => sum + row.total_cents, 0);
  const window = (days: number) => {
    const total = totalIn(days - 1, 0);
    const prior = totalIn(2 * days - 1, days);
    const deltaPct = prior > 0 ? ((total - prior) / prior) * 100 : null;
    return {
      range: { start: addDays(state.todayKey, -(days - 1)), end: state.todayKey },
      requestFrom: addDays(state.todayKey, -(2 * days - 1)),
      totalCents: total, totalText: formatMoney(total / 100), priorCents: prior,
      deltaPct, deltaText: deltaPct === null ? "No prior period" : `${Math.abs(deltaPct).toFixed(1)}%`,
      direction: deltaPct === null ? null : deltaPct >= 0 ? "up" : "down",
    };
  };
  return {
    mrrCents, mrrText: formatMoney(mrrCents / 100), activeSubscriptions: active,
    mrrDetail: `${active} active subscription${active === 1 ? "" : "s"}`,
    failedCount: failedRows.length,
    failedBody: `${failedRows.length} subscription${failedRows.length === 1 ? " has" : "s have"} a failed renewal payment`,
    failedIds: failedRows.map((row) => row.id).sort(),
    defaultRange: window(30), sevenDayRange: window(7),
  };
}

function initialState(): FixtureState {
  const runId = randomUUID();
  const route = `__overview-finance-session-${randomBytes(24).toString("base64url")}`;
  return {
    version: 1, runId, createdAt: new Date().toISOString(),
    apiBase: process.env.OVERVIEW_SMOKE_API_BASE_URL?.replace(/\/$/, "") || DEFAULT_API_BASE,
    todayKey: utcTodayKey(),
    providerId: `ovf-${runId}`,
    stripeAccountId: null, productIds: [], payerIds: [],
    subscriptions: SUBSCRIPTION_PLAN.map((row) => ({ id: randomUUID(), ...row })),
    orders: ORDER_PLAN.map((row) => ({ id: randomUUID(), ...row })),
    identities: {}, teamMemberId: randomUUID(),
    helper: { directory: `${HELPER_ROOT}/${route}`, route: `/${route}`, files: {} },
  };
}

async function prepare(): Promise<void> {
  credentials();
  if (!credentials().management) throw new Error("SUPABASE_ACCESS_TOKEN is required (order seeding and atomic cleanup).");
  try { await access(FIXTURE_PATH); throw new Error(`Fixture already exists at ${FIXTURE_PATH}; run cleanup first.`); }
  catch (error) { if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error; }
  if (!(await isSandbox())) throw new Error("Refusing: the Stripe connection is not a sandbox key.");
  const products = await serviceRest("GET", "billing_products?status=eq.active&active=eq.true&order=sort_order.asc&select=id&limit=2");
  if (!Array.isArray(products.body) || products.body.length < 2) throw new Error("Need two active catalog products.");
  const state = initialState();
  state.productIds = products.body.map((row: { id: string }) => row.id);
  await saveState(state);
  const suffix = state.runId.slice(0, 12);
  try {
    for (const role of roles) {
      const email = `overview-finance-smoke-${role}-${suffix}@example.test`;
      const password = `Ov!${randomBytes(25).toString("base64url")}8Q`;
      const userId = await createAuthUser(email, password, `Synthetic Finance ${role}`);
      state.identities[role] = { userId, email, password, session: await signIn(email, password) };
      await saveState(state);
    }
    const now = new Date().toISOString();
    await serviceRest("POST", "providers", [{
      provider_id: state.providerId, provider_name: "Synthetic Finance Business", office_name: "Synthetic Finance Office",
      email: identity(state, "owner").email, auth_user_id: identity(state, "owner").userId, access_disabled: false, created_at: now,
    }]);
    await serviceRest("POST", "team_members", [{
      id: state.teamMemberId, provider_id: state.providerId, name: "Synthetic Finance Staff",
      email: identity(state, "staff").email, auth_user_id: identity(state, "staff").userId,
      activation_status: "activated", office_role: "staff", claimed_at: now, created_at: now,
    }]);
    // Same provisioning rail a real staff code login runs (assignment +
    // provider_staff profile + training viewer link) so the operations app
    // opens the office desk for BOTH identities instead of the claimed-
    // workspace placeholder.
    for (const role of roles) {
      await serviceRest("POST", "rpc/provision_staff_login", {
        p_user_id: identity(state, role).userId, p_email: identity(state, role).email,
        p_display_name: role === "owner" ? "Synthetic Finance Owner" : "Synthetic Finance Staff",
        p_account_code: state.providerId,
      }, [200, 204]);
    }
    // A real Stripe TEST connected account (platform-controlled, no dashboard)
    // so the office is honestly "connected": the dashboard route reads the
    // balance and payouts from it (both tolerate an unonboarded account).
    const stripe = await getStripe();
    const account = await stripe.accounts.create({
      country: "US", email: identity(state, "owner").email,
      business_profile: { name: "Synthetic Finance Office" },
      controller: {
        stripe_dashboard: { type: "none" }, fees: { payer: "application" },
        losses: { payments: "application" }, requirement_collection: "application",
      },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { thinnr_provider_id: state.providerId, thinnr_smoke_run: state.runId },
    });
    state.stripeAccountId = account.id;
    await saveState(state);
    await serviceRest("POST", "billing_connected_accounts", [{
      provider_id: state.providerId, stripe_account_id: account.id, origin: "created", dashboard_type: "none",
      charges_enabled: Boolean(account.charges_enabled), payouts_enabled: Boolean(account.payouts_enabled),
      details_submitted: Boolean(account.details_submitted), requirements: {}, capabilities: {},
      default_currency: "usd", business_name: "Synthetic Finance Office", email: identity(state, "owner").email,
      tax_enabled: false, oauth_refresh_token: null, livemode: false, last_synced_at: now, disconnected_at: null,
      stripe_customer_emails: "off", stripe_customer_emails_checked_at: now,
    }]);
    const payers = await serviceRest("POST", "billing_payers", state.subscriptions.map((row, index) => ({
      provider_id: state.providerId, patient_id: null, name: `Synthetic Payer ${index + 1}`,
      email: `overview-finance-smoke-payer-${index + 1}-${suffix}@example.test`, phone: null, stripe_customer_id: null,
    })));
    state.payerIds = (payers.body as Array<{ id: string }>).map((row) => row.id);
    await saveState(state);
    await serviceRest("POST", "billing_subscriptions", state.subscriptions.map((row, index) => ({
      id: row.id, provider_id: state.providerId, payer_id: state.payerIds[index], patient_id: null,
      product_id: state.productIds[index % state.productIds.length],
      stripe_subscription_id: `sub_smoke_${state.runId.slice(0, 8)}_${index}`, stripe_customer_id: null,
      status: row.status, unit_price_cents: row.unit_price_cents, shipping_charge_cents: 0, application_fee_cents: 0,
      shipping_address: {}, current_period_end: addDays(state.todayKey, row.cadence_weeks * 7),
      cancel_at_period_end: false, canceled_at: row.status === "canceled" ? now : null,
      cancel_token: randomBytes(24).toString("base64url"), livemode: false, created_at: now,
      cadence_weeks: row.cadence_weeks, quantity: row.quantity,
      payment_failure_count: row.status === "past_due" || row.status === "unpaid" ? 2 : 0,
      last_payment_failed_at: row.status === "past_due" || row.status === "unpaid" ? now : null,
      last_failure_message: row.status === "past_due" || row.status === "unpaid" ? "Your card was declined." : null,
    })));
    // Paid orders are inserted with triggers off: the paid-order trigger would
    // otherwise queue a WarehouseCraft submission for a synthetic office.
    const orderValues = state.orders.map((row) => {
      const at = `${addDays(state.todayKey, -row.daysAgo)}T12:00:00.000Z`;
      const orderNumber = `SM${randomBytes(3).toString("hex").toUpperCase()}`;
      return `(${sqlLiteral(row.id)}::uuid, ${sqlLiteral(orderNumber)}, ${sqlLiteral(state.providerId)}, ${sqlLiteral(state.payerIds[0])}::uuid, null, 'one_time', null, 'paid', 'usd', ${row.total_cents}, 0, 0, ${row.total_cents}, 0, 0, 0, ${row.total_cents}, 0, 0, 0, '{}'::jsonb, false, ${sqlLiteral(at)}::timestamptz, 'shipped', ${sqlLiteral(at)}::timestamptz, ${sqlLiteral(at)}::timestamptz)`;
    }).join(",\n");
    await managementQuery(`
begin;
set local session_replication_role = replica;
insert into public.billing_orders (id, order_number, provider_id, payer_id, patient_id, kind, subscription_id, status, currency,
  subtotal_cents, shipping_charge_cents, tax_cents, total_cents, application_fee_cents, application_fee_collected_cents,
  stripe_fee_cents, office_net_cents, hard_cost_cents, shipping_cost_cents, hq_profit_cents, shipping_address, livemode,
  paid_at, fulfillment_status, created_at, updated_at)
values
${orderValues};
commit;`);
    await saveState(state);
  } catch (error) {
    await saveState(state);
    throw error;
  }
  console.log(`Prepared fixture: ${FIXTURE_PATH}`);
  console.log(`Run ID: ${state.runId}`);
  console.log(`Provider ID: ${state.providerId}`);
  console.log(`Stripe test account: ${state.stripeAccountId}`);
  printExpected(state);
}

function printExpected(state: FixtureState): void {
  const expected = expectedFigures(state);
  console.log(JSON.stringify({
    todayKey: state.todayKey,
    mrr: { cents: expected.mrrCents, display: expected.mrrText, detail: expected.mrrDetail },
    failedPayments: { count: expected.failedCount, body: expected.failedBody, subscriptionIds: expected.failedIds },
    defaultRange: expected.defaultRange, sevenDayRange: expected.sevenDayRange,
  }, null, 2));
}

async function refreshSessions(state: FixtureState): Promise<void> {
  for (const role of roles) {
    const found = state.identities[role];
    if (found) found.session = await signIn(found.email, found.password);
  }
  await saveState(state);
}
async function writeHelper(state: FixtureState): Promise<void> {
  await refreshSessions(state);
  await mkdir(state.helper.directory, { recursive: true, mode: 0o700 });
  await chmod(state.helper.directory, 0o700);
  const projectRef = new URL(credentials().url).hostname.split(".")[0];
  const storageKey = `sb-${projectRef}-auth-token`;
  for (const role of roles) {
    const fileName = `${role}-${randomBytes(18).toString("base64url")}.html`;
    const html = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>Temporary synthetic tester session</title><script>
(() => {
  "use strict";
  const session = ${JSON.stringify(identity(state, role).session).replace(/</g, "\\u003c")};
  localStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(session));
  localStorage.setItem("thinnr-ops-code-login-at", String(Date.now()));
  localStorage.removeItem("thinnr-ops-persona");
  const target = new URLSearchParams(location.search).get("to") || "/";
  location.replace(target.startsWith("/") ? target : "/");
})();
</script><noscript>JavaScript is required.</noscript>`;
    await writeFile(`${state.helper.directory}/${fileName}`, html, { mode: 0o600 });
    await chmod(`${state.helper.directory}/${fileName}`, 0o600);
    state.helper.files[role] = `${state.helper.route}/${fileName}`;
  }
  await saveState(state);
  const helperName = state.helper.route.slice(1);
  await mkdir(WEB_PUBLIC, { recursive: true });
  await rm(`${WEB_PUBLIC}/${helperName}`, { force: true });
  await symlink(state.helper.directory, `${WEB_PUBLIC}/${helperName}`);
  const lines = [`artifacts/thinnr-operations/public/${helperName}`, `tmp/${helperName}`];
  try {
    const exclude = await readFile(EXCLUDE_PATH, "utf8");
    if (!exclude.includes(helperName)) await writeFile(EXCLUDE_PATH, `${exclude.trimEnd()}\n${lines.join("\n")}\n`);
  } catch {
    await writeFile(EXCLUDE_PATH, `${lines.join("\n")}\n`);
  }
  for (const role of roles) console.log(`${role} helper path: ${state.helper.files[role]}`);
}

async function api(state: FixtureState, path: string, role: Role, expected = [200]) {
  const token = identity(state, role).session.access_token;
  if (typeof token !== "string") throw new Error(`Fixture session for ${role} has no access token.`);
  return request(`${state.apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } }, expected);
}

async function verify(keep: boolean): Promise<void> {
  const state = await loadState();
  const override = process.env.OVERVIEW_SMOKE_API_BASE_URL?.replace(/\/$/, "");
  if (override) state.apiBase = override;
  await refreshSessions(state);
  const expected = expectedFigures(state);
  // The independently computed plan must agree with the server's exported formula.
  assert(monthlyRecurringRevenueCents(state.subscriptions) === expected.mrrCents, `plan MRR agrees with reporting formula (${expected.mrrCents} cents)`);
  assert(needsAttentionSubscriptionCount(state.subscriptions) === expected.failedCount, `plan failed count agrees with reporting (${expected.failedCount})`);

  const health = await request(`${state.apiBase}/healthz`, {}, [200, 404]).catch(() => null);
  if (!health) throw new Error(`API is not reachable at ${state.apiBase}.`);

  for (const [label, window] of [["default 30-day", expected.defaultRange], ["7-day", expected.sevenDayRange]] as const) {
    const dashboard = await api(state, `/billing/office/dashboard?from=${window.requestFrom}&to=${window.range.end}`, "owner");
    const body = dashboard.body;
    assert(body.mrr_cents === expected.mrrCents, `${label}: dashboard mrr_cents = ${expected.mrrCents}`);
    assert(body.active_subscriptions === expected.activeSubscriptions, `${label}: active_subscriptions = ${expected.activeSubscriptions}`);
    assert(body.needs_attention_subscriptions === expected.failedCount, `${label}: needs_attention_subscriptions = ${expected.failedCount}`);
    assert(body.account_connected === true, `${label}: account_connected`);
    assert(Array.isArray(body.series) && body.series[0]?.date === window.requestFrom && body.series.at(-1)?.date === window.range.end,
      `${label}: series spans ${window.requestFrom}..${window.range.end}`);
    const inRange = body.series.filter((point: { date: string }) => point.date >= window.range.start).reduce((sum: number, point: { collected_cents: number }) => sum + point.collected_cents, 0);
    const prior = body.series.filter((point: { date: string }) => point.date < window.range.start).reduce((sum: number, point: { collected_cents: number }) => sum + point.collected_cents, 0);
    assert(inRange === window.totalCents, `${label}: collected in range = ${window.totalCents}`);
    assert(prior === window.priorCents, `${label}: collected in prior window = ${window.priorCents}`);
  }
  const attention = await api(state, "/billing/office/subscriptions?status=needs_attention", "owner");
  const ids = (attention.body.items as Array<{ id: string; status: string }>).map((row) => row.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(expected.failedIds), "needs_attention lists exactly the past_due + unpaid rows");
  assert(attention.body.items.every((row: { status: string }) => row.status === "past_due" || row.status === "unpaid"), "needs_attention rows carry failed statuses");
  const all = await api(state, "/billing/office/subscriptions", "owner");
  assert(all.body.items.length === state.subscriptions.length, `office lists all ${state.subscriptions.length} seeded subscriptions`);
  const status = await api(state, "/billing/office/status", "owner");
  assert(status.body.account?.stripe_account_id === state.stripeAccountId, "office status shows the synthetic Stripe test account");

  const staff = await api(state, `/billing/office/dashboard?from=${expected.defaultRange.requestFrom}&to=${expected.defaultRange.range.end}`, "staff", [403]);
  assert(staff.status === 403 && typeof staff.body?.error === "string", "staff member receives 403 from the dashboard");
  const staffStatus = await api(state, "/billing/office/status", "staff", [200, 403]);
  assert(staffStatus.status === 403 || staffStatus.body?.viewer?.can_manage === false, "staff member cannot manage payments");
  const roster = await api(state, "/office/roster", "staff", [200, 404]).catch(() => null);
  if (roster && roster.status === 200) console.log("ok - staff member can read the office roster");
  printExpected(state);
  if (!keep) await cleanup();
}

async function cleanup(): Promise<void> {
  let state: FixtureState;
  try { state = await loadState(); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { console.log(`Fixture already absent: ${FIXTURE_PATH}`); return; }
    throw error;
  }
  const providerId = sqlLiteral(state.providerId);
  const actorIds = Object.values(state.identities).filter(Boolean).map((item) => sqlLiteral(item!.userId)).join(",") || "null";
  await managementQuery(`
begin;
set local session_replication_role = replica;
do $cleanup$
declare
  t text;
  v_provider text := ${providerId};
begin
  for t in select table_name from information_schema.columns where table_schema='public' and column_name='order_id' and table_name like 'billing\\_%' loop
    execute format('delete from public.%I where order_id in (select id from public.billing_orders where provider_id = $1)', t) using v_provider;
  end loop;
  for t in select table_name from information_schema.columns where table_schema='public' and column_name='subscription_id' and table_name like 'billing\\_%' and table_name <> 'billing_orders' loop
    execute format('delete from public.%I where subscription_id in (select id from public.billing_subscriptions where provider_id = $1)', t) using v_provider;
  end loop;
  for t in select table_name from information_schema.columns where table_schema='public' and column_name='provider_id' and data_type='text' and table_name like 'billing\\_%' and table_name not in ('billing_orders','billing_subscriptions','billing_payers','billing_connected_accounts') loop
    execute format('delete from public.%I where provider_id = $1', t) using v_provider;
  end loop;
  delete from public.billing_orders where provider_id = v_provider;
  delete from public.billing_subscriptions where provider_id = v_provider;
  delete from public.billing_payers where provider_id = v_provider;
  delete from public.billing_connected_accounts where provider_id = v_provider;
  if to_regclass('public.admin_audit_events') is not null then
    delete from public.admin_audit_events where provider_id = v_provider or actor_user_id in (${actorIds});
  end if;
  if to_regclass('public.provider_account_locks') is not null then
    delete from public.provider_account_locks where account_id = v_provider;
  end if;
  for t in select c.table_name from information_schema.columns c join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name and tb.table_type='BASE TABLE' where c.table_schema='public' and c.column_name='provider_id' and c.data_type='text' and c.table_name not like 'billing\\_%' and c.table_name not in ('providers','team_members','patients') loop
    execute format('delete from public.%I where provider_id = $1', t) using v_provider;
  end loop;
  delete from public.team_members where provider_id = v_provider or auth_user_id in (${actorIds});
  if to_regclass('public.training_viewers') is not null then
    delete from public.training_viewers where auth_user_id in (${actorIds}) or account_id = v_provider;
  end if;
  delete from public.staff_role_assignments where provider_account_code = v_provider;
  delete from public.profiles where id in (${actorIds});
  delete from public.providers where provider_id = v_provider;
end $cleanup$;
commit;`);
  if (state.stripeAccountId) {
    const stripe = await getStripe();
    try { await stripe.accounts.del(state.stripeAccountId); }
    catch (error: any) { if (error?.code !== "resource_missing") throw error; }
  }
  for (const found of Object.values(state.identities)) if (found) await deleteAuthUser(found.userId);
  for (const table of ["billing_orders", "billing_subscriptions", "billing_payers", "billing_connected_accounts", "team_members"]) {
    const rows = await serviceRest("GET", `${table}?provider_id=eq.${encodeURIComponent(state.providerId)}&select=provider_id`);
    assert(Array.isArray(rows.body) && rows.body.length === 0, `fixture ${table} rows removed`);
  }
  const providers = await serviceRest("GET", `providers?provider_id=eq.${encodeURIComponent(state.providerId)}&select=provider_id`);
  assert(Array.isArray(providers.body) && providers.body.length === 0, "fixture provider row removed");
  for (const found of Object.values(state.identities)) if (found) assert(await authUserAbsent(found.userId), `auth user removed ${found.userId}`);
  const helperName = state.helper.route.slice(1);
  await rm(`${WEB_PUBLIC}/${helperName}`, { force: true });
  await rm(state.helper.directory, { recursive: true, force: true });
  try {
    const exclude = await readFile(EXCLUDE_PATH, "utf8");
    await writeFile(EXCLUDE_PATH, `${exclude.split(/\r?\n/).filter((line) => line && !line.includes(helperName)).join("\n")}\n`);
  } catch { /* no exclude file */ }
  await rm(FIXTURE_PATH, { force: true });
  console.log(`Removed fixture: ${FIXTURE_PATH}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "prepare") await prepare();
  else if (command === "helper") await writeHelper(await loadState());
  else if (command === "verify") await verify(process.argv.includes("--keep"));
  else if (command === "expected") printExpected(await loadState());
  else if (command === "cleanup") await cleanup();
  else throw new Error("Use prepare, helper, verify [--keep], expected, or cleanup.");
}
main().catch((error) => {
  // Error messages are deliberately scrubbed of response bodies and credentials.
  console.error(error instanceof Error ? error.message : "Overview finance smoke harness failed.");
  process.exitCode = 1;
});
