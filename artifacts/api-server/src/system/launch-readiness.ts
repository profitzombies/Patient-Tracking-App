/**
 * Provider launch readiness — a read-only, HQ-facing checklist of everything
 * a real office needs before its owner can sign in and connect Stripe.
 *
 * Every check only READS: it lists Stripe webhook endpoints, retrieves the
 * platform account, lists Resend domains and fetches the Twilio Verify
 * service. Nothing here creates, updates or deletes a vendor object — the
 * user makes changes in each vendor's dashboard and re-runs the check.
 *
 * Secrets never leave this module: checks report presence, format and
 * vendor verdicts, never key material.
 */
import Stripe from "stripe";
import { publicOrigin } from "../billing/app-origin";
import { getBillingModeSelection } from "../billing/mode-state";
import { selectMany } from "../billing/store";
import * as stripeClient from "../billing/stripe-client";
import { getStripe, getStripeCredentials } from "../billing/stripe-client";
import type { StripeMode } from "../billing/stripe-environment";
import {
  accountDefaultApiVersion, evaluateWebhookEndpoint, EXPECTED_STRIPE_API_VERSION,
  recommendedWebhookEvents, requiredWebhookEvents,
} from "../billing/webhook-endpoints";
import { suggestedPatientInviteUrl } from "../lib/patient-invite-link";
import { resolvePatientAppLinks, type StoreLinks } from "../lib/patient-app-link";
import { loadOrgPolicy } from "../lib/org-policy";
import {
  LIVE_WAREHOUSE_LOGIN, TEST_WAREHOUSE_LOGIN, missingLiveWarehouseLogin, requestedWarehouseTenant, warehouseCraftConfig, warehouseTenantMode,
} from "../shipping/warehousecraft";

export type ReadinessStatus = "pass" | "warn" | "fail" | "manual";

export interface ReadinessCheck {
  id: string;
  section: "app" | "stripe_live" | "stripe_test" | "warehouse" | "email" | "sms";
  label: string;
  status: ReadinessStatus;
  /** What was found, in plain language. */
  detail: string;
  /** What to do about it; null when nothing is needed. */
  fix: string | null;
  /** A value the user needs to copy into a vendor dashboard (e.g. a URL). */
  copyValue?: string;
}

export interface LaunchReadiness {
  checkedAt: string;
  mode: StripeMode | null;
  checks: ReadinessCheck[];
}

export { REQUIRED_CONNECT_EVENTS } from "../billing/webhook-endpoints";
const VENDOR_TIMEOUT_MS = 8_000;
/** A client order id no real order can carry (real ones are 8 characters). */
const WAREHOUSE_PROBE_ORDER_ID = "THINNR-READINESS-PROBE";

export interface ReadinessDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  billingMode: () => Promise<{ mode: StripeMode }>;
  /** Verified Stripe client for a mode; throws when keys are missing or the account mismatches. */
  stripe: (mode: StripeMode) => Promise<Pick<Stripe, "webhookEndpoints"> & Partial<Pick<Stripe, "events">>>;
  /** Throws when the mode's key trio is missing or malformed. */
  credentials: (mode: StripeMode) => Promise<unknown>;
  origin: () => string;
  now: () => Date;
  /** WarehouseCraft order API address and auth header for the tenant `env` selects; the header is sent, never reported. */
  warehouse: (env: NodeJS.ProcessEnv) => { orderApiBaseUrl: string | null; authorization: string | null };
  /** Active catalog products missing what the warehouse needs to ship them. */
  catalogGaps: () => Promise<CatalogGap[]>;
  /** HQ's App Store / Google Play links (Organization settings); throws when unreadable. */
  storeLinks: () => Promise<StoreLinks>;
}

export interface CatalogGap { name: string; missingSku: boolean; missingWeight: boolean }

async function activeCatalogGaps(): Promise<CatalogGap[]> {
  const rows = await selectMany("billing_products", "active=eq.true&select=name,warehousecraft_sku,shipping_weight_oz&order=sort_order.asc,name.asc");
  return rows
    .map((row) => ({
      name: String(row.name ?? "Unnamed product"),
      missingSku: !String(row.warehousecraft_sku ?? "").trim(),
      missingWeight: !(Number(row.shipping_weight_oz) > 0),
    }))
    .filter((gap) => gap.missingSku || gap.missingWeight);
}

const defaultDeps: ReadinessDeps = {
  env: process.env,
  fetch: (...args) => fetch(...args),
  billingMode: getBillingModeSelection,
  stripe: getStripe,
  credentials: getStripeCredentials,
  origin: publicOrigin,
  now: () => new Date(),
  warehouse: warehouseCraftConfig,
  catalogGaps: activeCatalogGaps,
  storeLinks: async () => {
    const policy = await loadOrgPolicy();
    return { appStoreUrl: policy.appStoreUrl, googlePlayUrl: policy.googlePlayUrl };
  },
};

/**
 * Vendor and configuration errors never reach the HQ response verbatim — a
 * message could echo a key fragment or a credential-bearing URL. Only a
 * short machine code (Stripe's `code`/`type`, a Node error code) rides along;
 * our own configuration errors, which name the setting and not its value, pass.
 */
function message(error: unknown, fallback: string): string {
  // Our own configuration errors name the missing setting, never its value.
  const ConfigError = "BillingConfigError" in stripeClient ? stripeClient.BillingConfigError : null;
  if (ConfigError && error instanceof ConfigError && error.message) return error.message;
  const raw = error && typeof error === "object"
    ? (error as { code?: unknown; type?: unknown }).code ?? (error as { type?: unknown }).type
    : null;
  const code = typeof raw === "string" && /^[A-Za-z_]{1,48}$/.test(raw) ? raw : null;
  return code ? `${fallback} (${code})` : fallback;
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

async function appChecks(deps: ReadinessDeps): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const configured = deps.env.OPERATIONS_APP_URL?.trim() ?? "";
  const appOrigin = configured ? originOf(configured) : null;
  let billingOrigin: string | null = null;
  let billingError: string | null = null;
  try {
    billingOrigin = originOf(deps.origin());
  } catch (error) {
    billingError = message(error, "The billing public origin is not configured.");
  }

  if (!configured) {
    checks.push({
      id: "app_url", section: "app", label: "Production app URL",
      status: "fail",
      detail: "OPERATIONS_APP_URL is not set, so emailed sign-in and setup links fall back to a development address.",
      fix: "Set OPERATIONS_APP_URL to the published site address (for example https://app.yourdomain.com) and republish.",
    });
  } else if (!appOrigin) {
    checks.push({
      id: "app_url", section: "app", label: "Production app URL",
      status: "fail",
      detail: "OPERATIONS_APP_URL is set but is not a valid https address.",
      fix: "Set OPERATIONS_APP_URL to the full https address of the published site.",
    });
  } else if (/\.replit\.dev$|\.repl\.co$/i.test(new URL(appOrigin).hostname)) {
    checks.push({
      id: "app_url", section: "app", label: "Production app URL",
      status: "fail",
      detail: `OPERATIONS_APP_URL points at a development address (${appOrigin}).`,
      fix: "Point OPERATIONS_APP_URL at the published site address instead of the workspace preview.",
    });
  } else {
    checks.push({
      id: "app_url", section: "app", label: "Production app URL",
      status: "pass", detail: `Emailed links open ${appOrigin}.`, fix: null,
    });
  }

  checks.push(await patientAppLinkCheck(deps));

  if (billingError || !billingOrigin) {
    checks.push({
      id: "billing_origin", section: "app", label: "Payments return address",
      status: "fail",
      detail: billingError ?? "BILLING_PUBLIC_ORIGIN is not a valid https address.",
      fix: "Set BILLING_PUBLIC_ORIGIN to the published site address so Stripe sends providers back to the right place.",
    });
  } else if (appOrigin && billingOrigin !== appOrigin) {
    checks.push({
      id: "billing_origin", section: "app", label: "Payments return address",
      status: "fail",
      detail: `Stripe returns providers to ${billingOrigin}, but emailed links open ${appOrigin}.`,
      fix: "Make BILLING_PUBLIC_ORIGIN and OPERATIONS_APP_URL the same published address.",
    });
  } else {
    checks.push({
      id: "billing_origin", section: "app", label: "Payments return address",
      status: "pass", detail: `Stripe returns providers to ${billingOrigin}.`, fix: null,
    });
  }
  return checks;
}

/**
 * The link patient invitation emails carry: HQ's store links first (TestFlight
 * and Play testing links count as interim values), else the Expo Go page.
 * Read strictly, the way the published site reads it: the workspace's Expo
 * preview never counts.
 */
async function patientAppLinkCheck(deps: ReadinessDeps): Promise<ReadinessCheck> {
  const env = deps.env;
  const base = { id: "patient_app_url", section: "app" as const, label: "Patient app link" };
  const suggested = suggestedPatientInviteUrl(env);
  const addStoreLinks = "Add the App Store and Google Play links under Organization settings (TestFlight / Play internal-testing links work until the listings are approved)";
  const setIt = `${addStoreLinks}, or set PATIENT_INVITE_URL for the published site to the app's Expo Go page${suggested ? ` (${suggested})` : " (the site address followed by /thinnr-mobile/)"} and republish.`;
  const copy = suggested ? { copyValue: suggested } : {};
  let storeLinks: StoreLinks | null = null;
  let storeLinksError = false;
  try {
    storeLinks = await deps.storeLinks();
  } catch {
    storeLinksError = true;
  }
  const resolved = resolvePatientAppLinks(storeLinks, env, { strict: true });
  if (resolved.ok && resolved.mode === "store") {
    const platforms = [
      resolved.appStoreUrl ? `iPhone patients open ${resolved.appStoreUrl}` : null,
      resolved.googlePlayUrl ? `Android patients open ${resolved.googlePlayUrl}` : null,
    ].filter((line): line is string => Boolean(line));
    const missing = !resolved.appStoreUrl ? "App Store" : !resolved.googlePlayUrl ? "Google Play" : null;
    const interim = resolved.interim ? " One of these is a testing link; replace it with the public listing once the app is approved." : "";
    if (missing && !resolved.expoGoUrl) {
      return {
        ...base, status: "warn", copyValue: resolved.link,
        detail: `${platforms.join("; ")}. The ${missing} link is blank and no Expo Go page is configured, so patients on the other platform have no install path yet.${interim}`,
        fix: `Add the ${missing} link under Organization settings, or set PATIENT_INVITE_URL to the Expo Go page as the interim path.`,
      };
    }
    const fallback = missing ? ` Until HQ adds the ${missing} link, patients on that platform get the Expo Go page (${resolved.expoGoUrl}).` : "";
    return {
      ...base, status: "pass", fix: null, copyValue: resolved.link,
      detail: `Patient invitation emails use the store links: ${platforms.join("; ")}.${fallback}${interim}`,
    };
  }
  const unreadable = storeLinksError ? " (HQ store links could not be read; the Expo Go page is used meanwhile.)" : "";
  if (resolved.ok) {
    return {
      ...base, status: "pass", fix: null, copyValue: resolved.link,
      detail: `Patient invitation emails open the Expo Go page ${resolved.link}. Add the App Store and Google Play links under Organization settings to switch them to the store.${unreadable}`,
    };
  }
  if (resolved.problem === "missing") {
    return {
      ...base, status: "fail", fix: setIt, ...copy,
      detail: `No store links are set and PATIENT_INVITE_URL is not set, so patient invitation emails have no app link on the live site and are held as not sent.${unreadable}`,
    };
  }
  if (resolved.problem === "dev_preview") {
    return {
      ...base, status: "fail", fix: setIt, ...copy,
      detail: `${resolved.setting} points at a development preview address (${resolved.value}), which stops working when the workspace closes.${unreadable}`,
    };
  }
  return {
    ...base, status: "fail", fix: setIt, ...copy,
    detail: `${resolved.setting} is set but is not a valid https address.${unreadable}`,
  };
}

async function modeCheck(deps: ReadinessDeps): Promise<{ check: ReadinessCheck; mode: StripeMode | null }> {
  try {
    const { mode } = await deps.billingMode();
    return {
      mode,
      check: mode === "live"
        ? { id: "billing_mode", section: "stripe_live", label: "Payments mode", status: "pass", detail: "Payments run in Live mode — real cards are charged.", fix: null }
        : {
          id: "billing_mode", section: "stripe_live", label: "Payments mode", status: "warn",
          detail: "Payments run in Test mode. Providers connect Stripe test accounts and no real money moves.",
          fix: "When the live checks below all pass, switch to Live in HQ → Settings → Payments mode. Stay in Test for dry runs.",
        },
    };
  } catch (error) {
    return {
      mode: null,
      check: {
        id: "billing_mode", section: "stripe_live", label: "Payments mode", status: "fail",
        detail: message(error, "The payments mode could not be read."),
        fix: "Check BILLING_DEPLOYMENT_ID and the database connection, then re-run this check.",
      },
    };
  }
}

async function stripeChecks(deps: ReadinessDeps, mode: StripeMode): Promise<ReadinessCheck[]> {
  const section = mode === "live" ? "stripe_live" : "stripe_test";
  const Label = mode === "live" ? "Live" : "Test";
  const prefix = `STRIPE_${mode.toUpperCase()}_`;
  const checks: ReadinessCheck[] = [];

  // Connect client ID: needed for "log in with an existing Stripe account".
  const clientId = deps.env[`${prefix}CONNECT_CLIENT_ID`]?.trim() ?? "";
  checks.push(!clientId
    ? { id: `${mode}_connect_client`, section, label: `${Label} Connect client ID`, status: "fail",
      detail: `${prefix}CONNECT_CLIENT_ID is not set, so the "connect an existing Stripe account" button is hidden.`,
      fix: `Copy the ${mode} client ID (starts with ca_) from Stripe → Settings → Connect → Onboarding options → OAuth, and save it as ${prefix}CONNECT_CLIENT_ID.` }
    : !/^ca_[A-Za-z0-9]+$/.test(clientId)
      ? { id: `${mode}_connect_client`, section, label: `${Label} Connect client ID`, status: "fail",
        detail: `${prefix}CONNECT_CLIENT_ID does not look like a Stripe client ID.`,
        fix: `Replace it with the ${mode} client ID from Stripe (it starts with ca_).` }
      : { id: `${mode}_connect_client`, section, label: `${Label} Connect client ID`, status: "pass", detail: "Set and correctly formatted.", fix: null });

  // OAuth redirect: Stripe must list this exact URL, and the API cannot read that list.
  let redirect: string | null = null;
  try { redirect = `${deps.origin()}/api/billing/oauth/callback`; } catch { redirect = null; }
  checks.push(redirect
    ? { id: `${mode}_oauth_redirect`, section, label: `${Label} OAuth redirect URL`, status: "manual",
      detail: "Stripe does not let us read the redirect list, so confirm it by hand.",
      fix: `In Stripe (${mode} mode) → Settings → Connect → Onboarding options → OAuth → Redirects, make sure this exact URL is listed.`,
      copyValue: redirect }
    : { id: `${mode}_oauth_redirect`, section, label: `${Label} OAuth redirect URL`, status: "fail",
      detail: "The redirect URL cannot be computed because the payments return address is not configured.",
      fix: "Set BILLING_PUBLIC_ORIGIN first." });

  // Keys + platform identity.
  let stripe: Awaited<ReturnType<ReadinessDeps["stripe"]>> | null = null;
  try {
    await deps.credentials(mode);
    stripe = await deps.stripe(mode);
    checks.push({ id: `${mode}_keys`, section, label: `${Label} Stripe keys`, status: "pass", detail: "Keys are valid and belong to the configured platform account.", fix: null });
  } catch (error) {
    checks.push({
      id: `${mode}_keys`, section, label: `${Label} Stripe keys`, status: "fail",
      detail: message(error, "Stripe keys could not be verified."),
      fix: `Check ${prefix}SECRET_KEY, ${prefix}PUBLISHABLE_KEY and ${prefix}PLATFORM_ACCOUNT_ID all come from the same Stripe account in ${mode} mode.`,
    });
  }

  // Webhook endpoints (listed, never created).
  const secrets = (["platform", "connect"] as const).map((kind) => ({
    kind, name: `${prefix}${kind.toUpperCase()}_WEBHOOK_SECRET`, set: /^whsec_\S+$/.test(deps.env[`${prefix}${kind.toUpperCase()}_WEBHOOK_SECRET`]?.trim() ?? ""),
  }));
  let endpoints: Stripe.WebhookEndpoint[] | null = null;
  let listError: string | null = null;
  let accountDefault: string | null = null;
  if (stripe) {
    try {
      const page = await stripe.webhookEndpoints.list({ limit: 100 });
      endpoints = page.data;
      // Unpinned endpoints receive events in the account's default version.
      if (endpoints.some((endpoint) => !endpoint.api_version)) accountDefault = await accountDefaultApiVersion(stripe);
    } catch (error) {
      listError = message(error, "Stripe webhook endpoints could not be listed.");
    }
  }
  for (const { kind, name, set } of secrets) {
    const id = `${mode}_webhook_${kind}`;
    const label = `${Label} ${kind === "connect" ? "Connect" : "platform"} webhook`;
    let url: string | null = null;
    try { url = `${deps.origin()}/api/billing/webhooks/${mode}/${kind}`; } catch { url = null; }
    const required = requiredWebhookEvents(kind);
    const recommended = recommendedWebhookEvents(kind);
    const where = kind === "connect"
      ? "Stripe → Developers → Webhooks → Add endpoint → \"Events on Connected accounts\""
      : "Stripe → Developers → Webhooks → Add endpoint → \"Events on Your account\"";
    if (!url) {
      checks.push({ id, section, label, status: "fail", detail: "The webhook URL cannot be computed.", fix: "Set BILLING_PUBLIC_ORIGIN first." });
      continue;
    }
    if (!stripe || !endpoints) {
      checks.push({ id, section, label, status: "fail",
        detail: listError ?? "Stripe keys must pass before webhook endpoints can be checked.",
        fix: "Fix the Stripe keys above, then re-run this check.", copyValue: url });
      continue;
    }
    const result = evaluateWebhookEndpoint({ kind, url, endpoints, secretSet: set, accountDefaultVersion: accountDefault });
    const allEvents = [...new Set([...required, ...recommended])];
    switch (result.verdict) {
      case "missing":
        checks.push({ id, section, label, status: "fail",
          detail: "Stripe has no webhook endpoint pointing at this site, so setup status will not update on its own.",
          fix: `In ${mode} mode, ${where}, choose API version ${EXPECTED_STRIPE_API_VERSION}, use this URL, select ${allEvents.join(", ")}, then save its signing secret as ${name}.`,
          copyValue: url });
        break;
      case "wrong_scope":
        checks.push(kind === "connect"
          ? { id, section, label, status: "fail", detail: "The endpoint only receives your platform's own events, so connected-account updates never arrive.", fix: `Delete it and re-add it via ${where}.`, copyValue: url }
          : { id, section, label, status: "fail", detail: "The endpoint receives connected-account events instead of your platform's own events.", fix: `Delete it and re-add it via ${where}.`, copyValue: url });
        break;
      case "disabled":
        checks.push({ id, section, label, status: "fail", detail: `The endpoint exists but Stripe reports it as ${result.endpoint?.status ?? "not enabled"}.`, fix: "Enable the endpoint in Stripe → Developers → Webhooks.", copyValue: url });
        break;
      case "missing_events":
        checks.push({ id, section, label, status: "fail", detail: `The endpoint is missing required events: ${result.missingRequired.join(", ")}.`, fix: "Edit the endpoint in Stripe and add those events.", copyValue: url });
        break;
      case "secret_missing":
        checks.push({ id, section, label, status: "fail", detail: `The endpoint exists, but ${name} is not set, so its deliveries will be rejected.`, fix: `Reveal the endpoint's signing secret in Stripe and save it as ${name}.`, copyValue: url });
        break;
      case "version_mismatch":
        // Stripe fixes an endpoint's version when it is created, so the only
        // repair is a replacement destination on the right version.
        checks.push({ id, section, label, status: "fail",
          detail: `Stripe sends this endpoint's events in API version ${result.apiVersion}${result.apiVersionSource === "account_default" ? " (the account default)" : ""}, but this server reads ${EXPECTED_STRIPE_API_VERSION}, so payment updates can be misread.`,
          fix: `In ${mode} mode, ${where}, choose API version ${EXPECTED_STRIPE_API_VERSION}, use this same URL and select ${allEvents.join(", ")}. Save the new signing secret as ${name}, then delete the old endpoint.`,
          copyValue: url });
        break;
      case "version_unknown":
        // Unpinned endpoints follow the account default, which Stripe only
        // shows on events; with none to read, the version cannot be judged.
        checks.push({ id, section, label, status: "warn",
          detail: result.apiVersionSource === "endpoint"
            ? `Stripe reports this endpoint's API version as "${result.apiVersion}", which is not a version this check can read, so it could not be compared with ${EXPECTED_STRIPE_API_VERSION}.`
            : `Stripe did not say which API version this endpoint's events use (it is not pinned to one and the account has no recent events to read it from), so it could not be compared with ${EXPECTED_STRIPE_API_VERSION}.`,
          fix: `In ${mode} mode, open Stripe → Developers → Webhooks → this endpoint and confirm its API version is ${EXPECTED_STRIPE_API_VERSION}. If it shows another version, replace it: ${where}, choose API version ${EXPECTED_STRIPE_API_VERSION}, use this same URL and select ${allEvents.join(", ")}. Save the new signing secret as ${name}, then delete the old endpoint.`,
          copyValue: url });
        break;
      case "missing_recommended":
        checks.push({ id, section, label, status: "warn",
          detail: `Setup updates will work, but ${result.missingRecommended.length} billing event${result.missingRecommended.length === 1 ? " is" : "s are"} not selected: ${result.missingRecommended.join(", ")}.`,
          fix: "Add those events to the endpoint so orders, refunds, payouts and disconnects stay in sync.", copyValue: url });
        break;
      case "ok":
        checks.push({ id, section, label, status: "pass", detail: "Enabled with the required events, and its signing secret is set.", fix: null, copyValue: url });
        break;
    }
  }
  return checks;
}

/**
 * Real orders reach the warehouse only from the published app, only on the
 * live tenant, and only while payments run Live. Development always stays on
 * the test tenant. Every vendor call here is a read-only status lookup.
 */
async function warehouseChecks(deps: ReadinessDeps, billingMode: StripeMode | null): Promise<ReadinessCheck[]> {
  const section = "warehouse" as const;
  const checks: ReadinessCheck[] = [];
  const published = deps.env.REPLIT_DEPLOYMENT === "1";
  const requested = requestedWarehouseTenant(deps.env);
  const missingLive = missingLiveWarehouseLogin(deps.env);
  // Live only with the flag AND the complete live login; the probe below signs
  // in with exactly the login that tenant uses (never the other one).
  const tenant = warehouseTenantMode(deps.env);
  const config = deps.warehouse(deps.env);
  const [baseName, usernameName, passwordName] = tenant === "live" ? LIVE_WAREHOUSE_LOGIN : TEST_WAREHOUSE_LOGIN;
  const loginLabel = tenant === "live" ? "live login (WAREHOUSECRAFT_API_*)" : "test login (NOVEX_API_*)";

  const connection = { id: "warehouse_connection", section, label: "WarehouseCraft connection" };
  if (!config.orderApiBaseUrl || !config.authorization) {
    checks.push({ ...connection, status: "fail",
      detail: `The ${tenant} warehouse tenant's order login is not set, so paid orders cannot be sent to the warehouse.`,
      fix: `Save the ${tenant} tenant's WarehouseCraft API username, password and order API address as ${usernameName}, ${passwordName} and ${baseName}.` });
  } else {
    try {
      const response = await deps.fetch(`${config.orderApiBaseUrl}/api/OrderStatusDatas?clientOrderId=${WAREHOUSE_PROBE_ORDER_ID}`, {
        headers: { Accept: "application/json", Authorization: config.authorization }, signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        checks.push({ ...connection, status: "fail", detail: `WarehouseCraft rejected the ${loginLabel}.`,
          fix: "Check the WarehouseCraft API username and password with WarehouseCraft support, then save them again." });
      } else if (response.status === 404 || response.ok) {
        // A signed-in lookup for an order that does not exist answers 404.
        checks.push({ ...connection, status: "pass", detail: `Signed in to the ${tenant} warehouse tenant with its ${loginLabel} using a read-only status lookup.`, fix: null });
      } else {
        checks.push({ ...connection, status: "fail", detail: `WarehouseCraft answered the status lookup with HTTP ${response.status}.`,
          fix: "Re-run the check in a minute; if it keeps failing, check the WarehouseCraft order API address." });
      }
    } catch (error) {
      checks.push({ ...connection, status: "fail", detail: message(error, "WarehouseCraft could not be reached."),
        fix: "Re-run the check in a minute; if it keeps failing, check the WarehouseCraft order API address." });
    }
  }

  const tenantBase = { id: "warehouse_tenant", section, label: "Warehouse tenant" };
  const goLive = `Save the live WarehouseCraft login as ${LIVE_WAREHOUSE_LOGIN.join(", ")}, then set WAREHOUSECRAFT_TENANT_MODE=live for the published app only and republish.`;
  if (!published) {
    checks.push(requested === "live"
      ? { ...tenantBase, status: "fail",
        detail: tenant === "live"
          ? "This development copy is set to the live warehouse tenant, so real orders could ship from development."
          : "This development copy has WAREHOUSECRAFT_TENANT_MODE=live. Only the published app may ask for the live tenant.",
        fix: "Remove WAREHOUSECRAFT_TENANT_MODE from the development environment; only the published app may use the live tenant." }
      : { ...tenantBase, status: "pass", detail: "Development uses the WarehouseCraft test tenant, so no real order ships from here.", fix: null });
  } else if (requested === "live" && missingLive.length) {
    // The flag alone never makes the tenant live: real orders stay held, and
    // the test tenant's NOVEX_API_* login is never used for them.
    checks.push({ ...tenantBase, status: "fail",
      detail: `WAREHOUSECRAFT_TENANT_MODE is live, but the live WarehouseCraft login is incomplete (${missingLive.join(", ")} not set). Real orders are held and nothing ships until it is complete.`,
      fix: `Save ${missingLive.join(", ")} for the published app with the live tenant's login from WarehouseCraft, then republish.` });
  } else if (tenant === "live") {
    checks.push({ ...tenantBase, status: "pass",
      detail: "The published app sends real orders to the live warehouse tenant with its own login while payments run Live. Test orders are never sent there.", fix: null });
  } else if (billingMode === "live") {
    checks.push({ ...tenantBase, status: "fail",
      detail: "Payments run Live, but the warehouse is on its test tenant, so real orders are held and nothing ships.", fix: goLive });
  } else {
    checks.push({ ...tenantBase, status: "warn",
      detail: "The published app uses the WarehouseCraft test tenant. That is right while payments run in Test; real orders would be held.",
      fix: `Before switching payments to Live: ${goLive}` });
  }

  const catalog = { id: "warehouse_catalog", section, label: "Products ready to ship" };
  try {
    const gaps = await deps.catalogGaps();
    const list = (rows: CatalogGap[]) => {
      const names = rows.slice(0, 5).map((row) => row.name).join(", ");
      return rows.length > 5 ? `${names} and ${rows.length - 5} more` : names;
    };
    const noSku = gaps.filter((gap) => gap.missingSku);
    const noWeight = gaps.filter((gap) => gap.missingWeight);
    if (noSku.length) {
      checks.push({ ...catalog, status: "fail",
        detail: `${noSku.length} active product${noSku.length === 1 ? " has" : "s have"} no WarehouseCraft SKU, so ${noSku.length === 1 ? "its" : "their"} orders cannot be sent to the warehouse: ${list(noSku)}.${noWeight.length ? ` ${noWeight.length} also ${noWeight.length === 1 ? "lacks" : "lack"} a shipping weight.` : ""}`,
        fix: "Add each product's SKU (and its shipping weight) in HQ → Payments → Catalog → open the product → Fulfillment." });
    } else if (noWeight.length) {
      checks.push({ ...catalog, status: "warn",
        detail: `${noWeight.length} active product${noWeight.length === 1 ? " has" : "s have"} no shipping weight, so shipping falls back to the flat charge: ${list(noWeight)}.`,
        fix: "Add each product's shipping weight in HQ → Payments → Catalog → open the product → Fulfillment." });
    } else {
      checks.push({ ...catalog, status: "pass", detail: "Every active product has a WarehouseCraft SKU and a shipping weight.", fix: null });
    }
  } catch (error) {
    checks.push({ ...catalog, status: "fail", detail: message(error, "The product catalog could not be read."), fix: "Re-run the check in a minute." });
  }
  return checks;
}

function parseSender(from: string): string | null {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).trim().toLowerCase() : null;
}

async function emailCheck(deps: ReadinessDeps): Promise<ReadinessCheck> {
  const base = { id: "email_domain", section: "email" as const, label: "Email sender domain" };
  const key = deps.env.RESEND_API_KEY?.trim();
  const from = deps.env.CLAIM_EMAIL_FROM?.trim();
  const domain = from ? parseSender(from) : null;
  if (!key || !domain) {
    return { ...base, status: "fail",
      detail: !key ? "RESEND_API_KEY is not set, so no email can be sent." : "CLAIM_EMAIL_FROM is not set to a valid sender address.",
      fix: "Set RESEND_API_KEY and CLAIM_EMAIL_FROM (for example THINNR <no-reply@mail.yourdomain.com>)." };
  }
  if (deps.env.CLAIM_EMAIL_DELIVERY_MODE?.trim() !== "live") {
    return { ...base, status: "fail", detail: "CLAIM_EMAIL_DELIVERY_MODE is not \"live\", so welcome and sign-in emails are not sent.", fix: "Set CLAIM_EMAIL_DELIVERY_MODE to live." };
  }
  try {
    const response = await deps.fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      // Only a send-only (restricted) key earns "confirm by hand"; any other
      // rejection means the key itself is wrong and nothing will send.
      const body = await response.json().catch(() => null) as { name?: string } | null;
      if (body?.name !== "restricted_api_key") {
        return { ...base, status: "fail", detail: "Resend rejected the email API key, so no emails will send.", fix: "Replace RESEND_API_KEY with a valid key from Resend → API Keys." };
      }
      return { ...base, status: "manual",
        detail: `The email key can send but cannot read domain settings, so ${domain} could not be checked automatically.`,
        fix: `In Resend → Domains, confirm ${domain} shows "Verified".` };
    }
    if (!response.ok) throw new Error(`Resend answered ${response.status}.`);
    const body = await response.json() as { data?: Array<{ name?: string; status?: string }> };
    const match = (body.data ?? []).find((row) => row.name?.toLowerCase() === domain);
    if (!match) {
      return { ...base, status: "fail", detail: `${domain} is not added in Resend, so emails from it will be rejected.`, fix: `Add ${domain} in Resend → Domains and publish its DNS records.` };
    }
    return match.status === "verified"
      ? { ...base, status: "pass", detail: `${domain} is verified in Resend.`, fix: null }
      : { ...base, status: "fail", detail: `${domain} is ${match.status ?? "not verified"} in Resend.`, fix: `Finish DNS verification for ${domain} in Resend → Domains.` };
  } catch (error) {
    return { ...base, status: "fail", detail: message(error, "Resend could not be reached."), fix: "Re-run the check in a minute; if it keeps failing, check the Resend API key." };
  }
}

async function smsCheck(deps: ReadinessDeps): Promise<ReadinessCheck> {
  const base = { id: "sms_verify", section: "sms" as const, label: "SMS sign-in codes" };
  const sid = deps.env.TWILIO_ACCOUNT_SID?.trim();
  const token = deps.env.TWILIO_AUTH_TOKEN?.trim();
  const service = deps.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (!sid || !token || !service) {
    return { ...base, status: "fail", detail: "Twilio credentials are incomplete, so office owners cannot finish the texted sign-in step.", fix: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID." };
  }
  if (deps.env.CLAIM_SMS_DELIVERY_MODE?.trim() !== "live") {
    return { ...base, status: "fail", detail: "CLAIM_SMS_DELIVERY_MODE is not \"live\", so texted sign-in codes are not sent.", fix: "Set CLAIM_SMS_DELIVERY_MODE to live." };
  }
  try {
    const response = await deps.fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    if (response.status === 401) return { ...base, status: "fail", detail: "Twilio rejected the account credentials.", fix: "Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." };
    if (response.status === 404) return { ...base, status: "fail", detail: "Twilio has no Verify service with the configured ID.", fix: "Copy the Verify service SID (starts with VA) from Twilio → Verify → Services into TWILIO_VERIFY_SERVICE_SID." };
    if (!response.ok) throw new Error(`Twilio answered ${response.status}.`);
    return { ...base, status: "pass", detail: "The Twilio Verify service is reachable.", fix: null };
  } catch (error) {
    return { ...base, status: "fail", detail: message(error, "Twilio could not be reached."), fix: "Re-run the check in a minute; if it keeps failing, check the Twilio settings." };
  }
}

export async function checkLaunchReadiness(overrides: Partial<ReadinessDeps> = {}): Promise<LaunchReadiness> {
  const deps: ReadinessDeps = { ...defaultDeps, ...overrides };
  const modeResult = modeCheck(deps);
  const [mode, live, test, warehouse, email, sms] = await Promise.all([
    modeResult, stripeChecks(deps, "live"), stripeChecks(deps, "test"),
    modeResult.then((result) => warehouseChecks(deps, result.mode)), emailCheck(deps), smsCheck(deps),
  ]);
  return {
    checkedAt: deps.now().toISOString(),
    mode: mode.mode,
    checks: [...(await appChecks(deps)), mode.check, ...live, ...test, ...warehouse, email, sms],
  };
}
