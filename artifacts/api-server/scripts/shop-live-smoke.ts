/**
 * Synthetic-only fixture for the patient in-app shop browser walk-through.
 *
 * Mints one throwaway patient in the CONNECTED sandbox office (the office
 * whose Stripe test account has charges enabled), writes a temporary helper
 * page that seeds the Expo web app's own storage keys, and tears everything
 * (billing rows, patient rows, auth user, helper files, git exclude) down.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/shop-live-smoke.ts prepare
 *   pnpm --filter @workspace/api-server exec tsx scripts/shop-live-smoke.ts helper
 *   pnpm --filter @workspace/api-server exec tsx scripts/shop-live-smoke.ts status
 *   pnpm --filter @workspace/api-server exec tsx scripts/shop-live-smoke.ts cleanup
 *
 * Refuses to run when the Stripe connection is not a sandbox key. Passwords,
 * sessions, and helper contents are written only to mode-0600 files; output
 * is limited to synthetic ids and random route paths.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONSENT_POLICY_VERSION } from "../src/privacy/consent";
import { connectedOpts, getStripe, getStripeCredentials } from "../src/billing/stripe-client";

const FIXTURE_PATH = "/tmp/thinnr-shop-fixture.json";
const HELPER_ROOT = resolve(process.cwd(), "../../tmp");
const MOBILE_PUBLIC = resolve(process.cwd(), "../thinnr-mobile/public");
const EXCLUDE_PATH = resolve(process.cwd(), "../../.git/info/exclude");

interface FixtureState {
  version: 1;
  runId: string;
  createdAt: string;
  providerId: string;
  officeName: string;
  patientId: string;
  userId: string;
  email: string;
  password: string;
  session: Record<string, unknown> | null;
  helper: { route: string; directory: string; file: string | null };
}

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
async function serviceRest(method: string, path: string, body?: unknown, expected = [200, 201, 204]) {
  const { url, service } = credentials();
  return request(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, expected);
}
async function managementQuery(query: string): Promise<any> {
  const { url, management } = credentials();
  if (!management) throw new Error("SUPABASE_ACCESS_TOKEN is required for atomic cleanup.");
  const ref = new URL(url).hostname.split(".")[0];
  return (await request(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${management}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }, [200, 201])).body;
}
const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function saveState(state: FixtureState) {
  await writeFile(FIXTURE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(FIXTURE_PATH, 0o600);
}
async function loadState(): Promise<FixtureState> {
  const state = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureState;
  if (state.version !== 1 || !state.patientId) throw new Error("The shop fixture file is invalid.");
  return state;
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

async function connectedOffice(): Promise<{ providerId: string; officeName: string }> {
  const stripe = await getStripeCredentials();
  if (!stripe.publishable.startsWith("pk_test_")) throw new Error("Refusing: the Stripe connection is not a sandbox key.");
  const accounts = await serviceRest("GET", "billing_connected_accounts?charges_enabled=eq.true&disconnected_at=is.null&livemode=eq.false&select=provider_id&limit=1");
  const providerId = accounts.body?.[0]?.provider_id;
  if (typeof providerId !== "string") throw new Error("No sandbox connected account with charges enabled.");
  const provider = await serviceRest("GET", `providers?provider_id=eq.${encodeURIComponent(providerId)}&select=office_name,provider_name&limit=1`);
  const officeName = provider.body?.[0]?.office_name ?? provider.body?.[0]?.provider_name ?? providerId;
  return { providerId, officeName: String(officeName) };
}

async function prepare() {
  credentials();
  try { await access(FIXTURE_PATH); throw new Error(`Fixture already exists at ${FIXTURE_PATH}; run cleanup first.`); }
  catch (error) { if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error; }
  const office = await connectedOffice();
  const runId = randomUUID();
  const suffix = runId.slice(0, 12);
  const route = `__shop-session-${randomBytes(24).toString("base64url")}`;
  const state: FixtureState = {
    version: 1, runId, createdAt: new Date().toISOString(),
    providerId: office.providerId, officeName: office.officeName,
    patientId: randomUUID(), userId: "",
    email: `shop-smoke-patient-${suffix}@example.test`,
    password: `Sh!${randomBytes(25).toString("base64url")}8Q`,
    session: null,
    helper: { route: `/${route}`, directory: `${HELPER_ROOT}/${route}`, file: null },
  };
  await saveState(state);
  const { url, service } = credentials();
  const created = await request(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: state.email, password: state.password, email_confirm: true,
      app_metadata: { thinnr_claim: "shop-live-smoke" },
      user_metadata: { display_name: "Synthetic Shop Smoke" },
    }),
  }, [200, 201]);
  state.userId = String(created.body.id);
  await saveState(state);
  const now = new Date().toISOString();
  await serviceRest("POST", "patients", [{
    id: state.patientId, name: "Synthetic Shop Patient", first_name: "Synthetic", last_name: "Shopper",
    email: state.email, phone: "+16175550123", activation_status: "activated", created_at: now,
    auth_user_id: state.userId, provider_id: state.providerId, profile_completed_at: now,
    deletion_requested_at: null, timezone: "America/New_York",
  }]);
  await serviceRest("POST", "patient_flags", [{ patient_id: state.patientId, onboarding_complete: true }]);
  await serviceRest("POST", "patient_consents", [{
    patient_id: state.patientId, policy_version: CONSENT_POLICY_VERSION,
    terms_accepted: true, privacy_accepted: true, health_data_accepted: true,
    photo_analysis_accepted: true, app_version: "shop-live-smoke", platform: "server",
  }]);
  state.session = await signIn(state.email, state.password);
  await saveState(state);
  console.log(`Prepared synthetic shop patient ${state.patientId} in office ${state.providerId} (${state.officeName}).`);
}

async function writeHelper() {
  const state = await loadState();
  state.session = await signIn(state.email, state.password);
  await mkdir(state.helper.directory, { recursive: true, mode: 0o700 });
  await chmod(state.helper.directory, 0o700);
  const projectRef = new URL(credentials().url).hostname.split(".")[0];
  const storageKey = `sb-${projectRef}-auth-token`;
  const fileName = `patient-${randomBytes(18).toString("base64url")}.html`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>Temporary synthetic tester session</title><script>
(() => {
  "use strict";
  const session = ${JSON.stringify(state.session).replace(/</g, "\\u003c")};
  localStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(session));
  localStorage.setItem("thinnr_app_mode_v1", "patient");
  const target = new URLSearchParams(location.search).get("to") || "/shop";
  location.replace(target.startsWith("/") ? target : "/shop");
})();
</script><noscript>JavaScript is required.</noscript>`;
  await writeFile(`${state.helper.directory}/${fileName}`, html, { mode: 0o600 });
  await chmod(`${state.helper.directory}/${fileName}`, 0o600);
  state.helper.file = `${state.helper.route}/${fileName}`;
  await saveState(state);
  const helperName = state.helper.route.slice(1);
  await mkdir(MOBILE_PUBLIC, { recursive: true });
  await rm(`${MOBILE_PUBLIC}/${helperName}`, { force: true });
  await symlink(state.helper.directory, `${MOBILE_PUBLIC}/${helperName}`);
  try {
    const exclude = await readFile(EXCLUDE_PATH, "utf8");
    if (!exclude.includes(helperName)) await writeFile(EXCLUDE_PATH, `${exclude.trimEnd()}\nartifacts/thinnr-mobile/public/${helperName}\ntmp/${helperName}\n`);
  } catch {
    await writeFile(EXCLUDE_PATH, `artifacts/thinnr-mobile/public/${helperName}\ntmp/${helperName}\n`);
  }
  console.log(`patient helper path: ${state.helper.file}`);
}

async function status() {
  const state = await loadState();
  const [orders, subs, carts, payers] = await Promise.all([
    serviceRest("GET", `billing_orders?patient_id=eq.${state.patientId}&select=id,order_number,status,total_cents,subscription_id,cart_id`),
    serviceRest("GET", `billing_subscriptions?patient_id=eq.${state.patientId}&select=id,status,cadence_weeks`),
    serviceRest("GET", `billing_carts?patient_id=eq.${state.patientId}&select=id,status`),
    serviceRest("GET", `billing_payers?patient_id=eq.${state.patientId}&select=id,stripe_customer_id`),
  ]);
  console.log(JSON.stringify({ patientId: state.patientId, orders: orders.body, subscriptions: subs.body, carts: carts.body, payers: (payers.body ?? []).map((row: any) => ({ id: row.id, hasCustomer: Boolean(row.stripe_customer_id) })) }, null, 2));
}

async function cleanup() {
  let state: FixtureState;
  try { state = await loadState(); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { console.log(`Fixture already absent: ${FIXTURE_PATH}`); return; }
    throw error;
  }
  // Stop the sandbox subscriptions first so the test account does not keep
  // renewing (and webhooking) for a patient that no longer exists.
  const subs = await serviceRest("GET", `billing_subscriptions?patient_id=eq.${state.patientId}&stripe_subscription_id=not.is.null&select=stripe_subscription_id,status`);
  const accounts = await serviceRest("GET", `billing_connected_accounts?provider_id=eq.${encodeURIComponent(state.providerId)}&select=stripe_account_id&limit=1`);
  const accountId = accounts.body?.[0]?.stripe_account_id;
  if (Array.isArray(subs.body) && subs.body.length && typeof accountId === "string") {
    const stripe: any = await getStripe();
    for (const row of subs.body) {
      if (["canceled", "ended"].includes(row.status)) continue;
      try { await stripe.subscriptions.cancel(row.stripe_subscription_id, { invoice_now: false, prorate: false }, connectedOpts(accountId)); }
      catch (error: any) { if (error?.code !== "resource_missing") throw error; }
    }
    console.log(`Canceled ${subs.body.length} sandbox subscription(s).`);
  }
  const pid = sqlLiteral(state.patientId);
  const query = `
begin;
set local session_replication_role = replica;
do $cleanup$
declare
  t text;
  v_patient uuid := ${pid}::uuid;
begin
  -- Children keyed by order / subscription / cart / payer of this patient.
  for t in select table_name from information_schema.columns where table_schema='public' and column_name='order_id' and table_name like 'billing\\_%' loop
    execute format('delete from public.%I where order_id in (select id from public.billing_orders where patient_id = $1 or payer_id in (select id from public.billing_payers where patient_id = $1))', t) using v_patient;
  end loop;
  for t in select table_name from information_schema.columns where table_schema='public' and column_name='subscription_id' and table_name like 'billing\\_%' and table_name <> 'billing_orders' loop
    execute format('delete from public.%I where subscription_id in (select id from public.billing_subscriptions where patient_id = $1 or payer_id in (select id from public.billing_payers where patient_id = $1))', t) using v_patient;
  end loop;
  delete from public.billing_orders where patient_id = v_patient or payer_id in (select id from public.billing_payers where patient_id = v_patient);
  delete from public.billing_subscriptions where patient_id = v_patient or payer_id in (select id from public.billing_payers where patient_id = v_patient);
  for t in select table_name from information_schema.columns where table_schema='public' and column_name='patient_id' and table_name not in ('patients') loop
    execute format('delete from public.%I where patient_id = $1', t) using v_patient;
  end loop;
  delete from public.patients where id = v_patient;
end $cleanup$;
commit;`;
  await managementQuery(query);
  const { url, service } = credentials();
  if (state.userId) {
    await request(`${url}/auth/v1/admin/users/${encodeURIComponent(state.userId)}`, {
      method: "DELETE", headers: { apikey: service, Authorization: `Bearer ${service}` },
    }, [200, 204, 404]);
  }
  const remaining = await serviceRest("GET", `patients?id=eq.${state.patientId}&select=id`);
  if (!Array.isArray(remaining.body) || remaining.body.length) throw new Error("fixture patient row still present");
  for (const table of ["billing_orders", "billing_subscriptions", "billing_carts", "billing_payers"]) {
    const rows = await serviceRest("GET", `${table}?patient_id=eq.${state.patientId}&select=id`);
    if (!Array.isArray(rows.body) || rows.body.length) throw new Error(`fixture ${table} rows still present`);
  }
  const helperName = state.helper.route.slice(1);
  await rm(`${MOBILE_PUBLIC}/${helperName}`, { force: true });
  await rm(state.helper.directory, { recursive: true, force: true });
  try {
    const exclude = await readFile(EXCLUDE_PATH, "utf8");
    await writeFile(EXCLUDE_PATH, `${exclude.split(/\r?\n/).filter(line => line && !line.includes(helperName)).join("\n")}\n`);
  } catch { /* no exclude file */ }
  await rm(FIXTURE_PATH, { force: true });
  console.log(`Removed synthetic shop patient ${state.patientId}, helper, and fixture.`);
}

async function main() {
  const command = process.argv[2];
  if (command === "prepare") await prepare();
  else if (command === "helper") await writeHelper();
  else if (command === "status") await status();
  else if (command === "cleanup") await cleanup();
  else throw new Error("Use prepare, helper, status, or cleanup.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
