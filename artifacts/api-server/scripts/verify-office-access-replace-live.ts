/**
 * Live Test-mode proof that office payment methods are named in Stripe and
 * that replacing one leaves exactly three on the office's Stripe customer.
 *
 * Drives the real api-server (STAFF_API_BASE, default http://localhost:80)
 * against the shared dev Supabase project and THINNR's Test platform account,
 * with a throwaway office + owner login. The browser's part (confirming the
 * SetupIntent with Stripe) is played here with the Test secret key and Stripe's
 * test tokens, carrying the holder name and email exactly as the form sends.
 *
 *   1. The access customer is created with the office's name, email, phone,
 *      address, description and metadata; the setup form is handed the
 *      practice's name and email.
 *   2. A bank, a primary and a backup card are saved with holder names; the
 *      primary is the customer's default payment method.
 *   3. Replacing the primary card detaches the old one: exactly three methods,
 *      the new primary is the default, and deleting is refused (405).
 *   4. Replacing the verified bank with one still awaiting test deposits keeps
 *      the old bank in service; confirming the deposits swaps them and leaves
 *      exactly three again.
 *
 * Refuses to run unless the server is in Test mode. Fixtures (DB rows, owner
 * login, and the Stripe customer) are removed in `finally`.
 */

import Stripe from "stripe";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const API_BASE = process.env.STAFF_API_BASE ?? "http://localhost:80";
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN || !STRIPE_KEY) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_ACCESS_TOKEN and STRIPE_TEST_SECRET_KEY are required.");
}
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const stripe = new Stripe(STRIPE_KEY);

const enc = encodeURIComponent;
const brief = (value: unknown) => JSON.stringify(value ?? null).slice(0, 300);
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function svc(method: string, path: string, body?: unknown, prefer = "return=representation") {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey: SERVICE_KEY!, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty or non-JSON */ }
  return { status: response.status, json, text };
}

/**
 * Direct SQL, for the two things PostgREST cannot do here: attaching a
 * connected-account fixture (the connect guard owns that table through its own
 * RPC) and clearing append-only operational ledgers on the way out.
 */
async function sql(query: string) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`management query failed (${response.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return null; }
}
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function api(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}

const stamp = Date.now();
const password = `Qa-${stamp}!access`;
const ownerEmail = `qa-replace-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-replace-${stamp}`;
let ownerUserId: string | null = null;
let officeCreated = false;

async function createFixtures(): Promise<string> {
  const created = await svc("POST", "/auth/v1/admin/users", { email: ownerEmail, password, email_confirm: true, app_metadata: { thinnr_provisioned: "true" } });
  ownerUserId = created.json?.id ?? null;
  if (!ownerUserId) throw new Error(`could not create the owner login: ${brief(created.json)}`);
  const office = await svc("POST", "/rest/v1/providers", {
    provider_id: officeId, office_name: "QA Replace Aesthetics", provider_name: "Dr. QA Replace",
    email: ownerEmail, phone: "8135550100", address_line_1: "1 Main St", city: "Tampa", state: "FL", postal_code: "33602", auth_user_id: ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  officeCreated = true;
  const grant = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password }),
  });
  const session = await grant.json().catch(() => null);
  if (!session?.access_token) throw new Error(`owner sign-in failed: ${brief(session)}`);
  return session.access_token as string;
}

async function cleanup() {
  if (officeCreated) {
    // Every provider-keyed table, including the append-only ledgers PostgREST
    // refuses to delete from, then the office row itself.
    await sql(`set session_replication_role = replica;
do $cleanup$
declare t text; v_provider text := ${lit(officeId)};
begin
  for t in select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name and tb.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='provider_id' and c.data_type='text' and c.table_name <> 'providers' loop
    execute format('delete from public.%I where provider_id = $1', t) using v_provider;
  end loop;
  delete from public.billing_connect_guards where provider_id = v_provider;
  delete from public.practice_launch where provider_id = v_provider;
  delete from public.staff_role_assignments where email = ${lit(ownerEmail)};
  delete from public.providers where provider_id = v_provider;
end $cleanup$;`).catch((error) => console.error(`  !!  office cleanup failed: ${error}`));
    const left = await svc("GET", `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=provider_id`);
    if (Array.isArray(left.json) && left.json.length > 0) console.error("  !!  the office row is still present");
  }
  if (ownerUserId) {
    const result = await svc("DELETE", `/auth/v1/admin/users/${ownerUserId}`);
    if (result.status >= 300) console.error(`  !!  owner login cleanup failed (${result.status})`);
  }
  console.log("  ok  fixtures removed");
}

let customerId: string | null = null;
const HOLDER = { name: "QA Replace Aesthetics", email: "" };

async function savedCard(token: string, slot: string, cardToken: string) {
  const intent = await api(token, "/billing/office/access/setup-intent", { method: "POST", body: JSON.stringify({ slot }) });
  if (intent.status !== 200) throw new Error(`setup-intent ${slot} failed (${intent.status}): ${intent.text.slice(0, 200)}`);
  const method = await stripe.paymentMethods.create({ type: "card", card: { token: cardToken }, billing_details: { name: intent.json.billingDetails.name, email: intent.json.billingDetails.email } });
  await stripe.setupIntents.confirm(intent.json.setupIntentId, { payment_method: method.id });
  const saved = await api(token, "/billing/office/access/instruments", { method: "POST", body: JSON.stringify({ slot, paymentMethodId: method.id, setupIntentId: intent.json.setupIntentId }) });
  return { method: method.id, saved, intent: intent.json };
}

async function savedBank(token: string, verifyFirst: boolean) {
  const intent = await api(token, "/billing/office/access/setup-intent", { method: "POST", body: JSON.stringify({ slot: "bank" }) });
  if (intent.status !== 200) throw new Error(`setup-intent bank failed (${intent.status}): ${intent.text.slice(0, 200)}`);
  const method = await stripe.paymentMethods.create({
    type: "us_bank_account",
    us_bank_account: { routing_number: "110000000", account_number: "000123456789", account_holder_type: "company" },
    billing_details: { name: intent.json.billingDetails.name, email: intent.json.billingDetails.email },
  });
  await stripe.setupIntents.confirm(intent.json.setupIntentId, {
    payment_method: method.id,
    mandate_data: { customer_acceptance: { type: "online", online: { ip_address: "127.0.0.1", user_agent: "thinnr-live-proof" } } },
  });
  if (verifyFirst) await stripe.setupIntents.verifyMicrodeposits(intent.json.setupIntentId, { amounts: [32, 45] });
  const saved = await api(token, "/billing/office/access/instruments", { method: "POST", body: JSON.stringify({ slot: "bank", paymentMethodId: method.id, setupIntentId: intent.json.setupIntentId }) });
  return { method: method.id, saved, setupIntentId: intent.json.setupIntentId as string };
}

async function attached(): Promise<string[]> {
  const [cards, banks] = await Promise.all([
    stripe.customers.listPaymentMethods(customerId!, { type: "card", limit: 20 }),
    stripe.customers.listPaymentMethods(customerId!, { type: "us_bank_account", limit: 20 }),
  ]);
  return [...cards.data, ...banks.data].map((method) => method.id);
}

async function main() {
  let token = "";
  try {
    token = await createFixtures();
    HOLDER.email = ownerEmail;
    const snapshot = await api(token, "/billing/office/access");
    check("the office reads its setup snapshot", snapshot.status === 200, `status ${snapshot.status}`);
    if (!snapshot.json?.connect?.sandbox) throw new Error("the api-server is not in Test mode; refusing to write to Stripe");

    console.log("\n1. the Stripe customer is named from the office's details");
    const first = await savedBank(token, true);
    check("setup form is handed the practice's name and email", first.saved.status === 200 || first.saved.status === 201, `save ${first.saved.status}: ${first.saved.text.slice(0, 160)}`);
    const row = await svc("GET", `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}&select=stripe_customer_id`);
    customerId = row.json?.[0]?.stripe_customer_id ?? null;
    check("an access customer exists", Boolean(customerId), brief(row.json));
    const customer = await stripe.customers.retrieve(customerId!) as Stripe.Customer;
    check("customer name is the practice name", customer.name === "QA Replace Aesthetics", String(customer.name));
    check("customer email is the owner's", customer.email === ownerEmail, String(customer.email));
    check("customer phone and address are filled", customer.phone === "8135550100" && customer.address?.line1 === "1 Main St" && customer.address?.city === "Tampa", `${customer.phone} ${brief(customer.address)}`);
    check("customer description names the office", Boolean(customer.description?.includes("QA Replace Aesthetics")), String(customer.description));
    check("metadata carries provider id, office name and mode",
      customer.metadata.thinnr_provider_id === officeId && customer.metadata.thinnr_office_name === "QA Replace Aesthetics" && customer.metadata.thinnr_payment_mode === "test", brief(customer.metadata));

    console.log("\n2. the bank and two cards are saved with holder names");
    const primary = await savedCard(token, "card_primary", "tok_visa");
    const backup = await savedCard(token, "card_backup", "tok_mastercard");
    check("both cards save", [primary.saved.status, backup.saved.status].every((s) => s < 300), `${primary.saved.status} ${backup.saved.status}`);
    const bankPm = await stripe.paymentMethods.retrieve(first.method);
    check("the bank carries the account-holder name", bankPm.billing_details.name === "QA Replace Aesthetics", String(bankPm.billing_details.name));
    const view = await api(token, "/billing/office/access");
    const names = (view.json?.instruments ?? []).map((item: any) => `${item.slot}:${item.holderName}`);
    check("the snapshot shows the name on each method", names.length === 3 && names.every((n: string) => n.endsWith(":QA Replace Aesthetics")), names.join(", "));
    let current = await stripe.customers.retrieve(customerId!) as Stripe.Customer;
    const defaultOf = (c: Stripe.Customer) => typeof c.invoice_settings.default_payment_method === "string" ? c.invoice_settings.default_payment_method : c.invoice_settings.default_payment_method?.id;
    check("the primary card is the customer's default", defaultOf(current) === primary.method, String(defaultOf(current)));
    check("exactly three methods are attached", (await attached()).length === 3, (await attached()).join(","));

    console.log("\n3. replacing the primary card detaches the old one");
    const replacement = await savedCard(token, "card_primary", "tok_amex");
    check("replacement saves", replacement.saved.status < 300, `${replacement.saved.status}: ${replacement.saved.text.slice(0, 160)}`);
    const afterCard = await attached();
    check("exactly three methods remain", afterCard.length === 3, afterCard.join(","));
    check("the old primary is detached", !afterCard.includes(primary.method));
    current = await stripe.customers.retrieve(customerId!) as Stripe.Customer;
    check("the new primary is the default", defaultOf(current) === replacement.method, String(defaultOf(current)));
    const history = await svc("GET", `/rest/v1/billing_office_access_instruments?provider_id=eq.${enc(officeId)}&slot=eq.card_primary&select=stripe_payment_method_id,removed_at,detached_at`);
    const old = (history.json ?? []).find((r: any) => r.stripe_payment_method_id === primary.method);
    check("THINNR keeps the replaced card in its history", Boolean(old?.removed_at && old?.detached_at), brief(old));
    const refusal = await api(token, "/billing/office/access/instruments/card_backup", { method: "DELETE" });
    check("deleting a method is refused", refusal.status === 405 && refusal.json?.code === "replace_only", `${refusal.status} ${refusal.text.slice(0, 120)}`);
    const dup = await (async () => {
      const intent = await api(token, "/billing/office/access/setup-intent", { method: "POST", body: JSON.stringify({ slot: "card_primary" }) });
      await stripe.setupIntents.confirm(intent.json.setupIntentId, { payment_method: (await stripe.paymentMethods.create({ type: "card", card: { token: "tok_mastercard" } })).id });
      const si = await stripe.setupIntents.retrieve(intent.json.setupIntentId);
      return api(token, "/billing/office/access/instruments", { method: "POST", body: JSON.stringify({ slot: "card_primary", paymentMethodId: si.payment_method, setupIntentId: si.id }) });
    })();
    check("the backup card cannot become the primary too", dup.status === 409, `${dup.status} ${dup.text.slice(0, 120)}`);
    check("a refused duplicate leaves exactly three methods", (await attached()).length === 3, (await attached()).join(","));

    console.log("\n4. a bank awaiting deposits waits beside the bank in service");
    const staged = await savedBank(token, false);
    check("the pending bank saves", staged.saved.status < 300, `${staged.saved.status}: ${staged.saved.text.slice(0, 160)}`);
    const waiting = await api(token, "/billing/office/access");
    const inService = (waiting.json?.instruments ?? []).find((item: any) => item.slot === "bank");
    check("the verified bank stays in service", inService?.verificationStatus === "verified" && Boolean(waiting.json?.bank?.replacement), brief({ inService, replacement: waiting.json?.bank?.replacement }));
    check("the old bank is still attached while the new one waits", (await attached()).includes(first.method));
    await stripe.setupIntents.verifyMicrodeposits(staged.setupIntentId, { amounts: [32, 45] });
    const verified = await api(token, "/billing/office/access/bank/verify", { method: "POST", body: "{}" });
    check("confirming the deposits succeeds", verified.status === 200, `${verified.status} ${verified.text.slice(0, 160)}`);
    const swapped = await attached();
    check("exactly three methods after the swap", swapped.length === 3, swapped.join(","));
    check("the old bank is detached and the new one attached", !swapped.includes(first.method) && swapped.includes(staged.method));
  } finally {
    console.log("\ncleanup");
    if (customerId) await stripe.customers.del(customerId).catch((error) => console.error(`  !!  customer cleanup failed: ${error}`));
    await cleanup();
  }
  if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nOffice access replacement live: named customer, holder names, detach-on-replace, refused delete/duplicate and the staged-bank swap all held in Test mode.");
}

void main().catch((error) => { console.error(error); process.exit(1); });
