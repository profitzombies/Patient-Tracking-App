import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingModeStatus } from "./mode-state";
import { getStripeCredentials } from "./stripe-client";
import { runWithBillingIdentity, type BillingIdentity } from "./stripe-environment";

/** Only identity is read across scopes. The route still authorizes the record. */
export function storedIdentityReference(path: string, query: Request["query"]): { table: string; field: string; value: string } | null {
  let match = path.match(/^\/api\/billing\/public\/(links|carts|subscriptions)\/([^/]+)/);
  if (match) return {
    table: match[1] === "links" ? "billing_payment_links" : match[1] === "carts" ? "billing_prebuilt_carts" : "billing_subscriptions",
    field: match[1] === "subscriptions" ? "cancel_token" : "token", value: decodeURIComponent(match[2]),
  };
  if (/^\/api\/billing\/public\/orders\//.test(path) && typeof query.token === "string") {
    return { table: "billing_payment_links", field: "token", value: query.token };
  }
  match = path.match(/^\/api\/billing\/office\/sales\/tap\/([0-9a-f-]{36})\//i);
  if (match) return { table: "billing_orders", field: "cart_id", value: match[1] };
  match = path.match(/^\/api\/(?:billing\/office|patient-data\/billing)\/(orders|subscriptions|carts)\/([^/]+)/);
  if (match && /^[0-9a-f-]{36}$/i.test(match[2])) return {
    table: match[1] === "orders" ? "billing_orders" : match[1] === "subscriptions" ? "billing_subscriptions" : "billing_prebuilt_carts",
    field: "id", value: match[2],
  };
  return null;
}

export async function identityForReference(reference: { table: string; field: string; value: string }): Promise<BillingIdentity> {
  const result = await supabaseAdmin("GET", `/rest/v1/${reference.table}?${reference.field}=eq.${encodeURIComponent(reference.value)}&select=stripe_mode,stripe_platform_account_id&limit=100`);
  const rows = result.json;
  if (result.status >= 300 || !Array.isArray(rows) || rows.length === 0 || rows.length >= 100) throw new Error("Billing record identity is unavailable.");
  const row = rows[0];
  if (rows.some((candidate) => candidate.stripe_mode !== row.stripe_mode || candidate.stripe_platform_account_id !== row.stripe_platform_account_id)) {
    throw new Error("Billing record identity is ambiguous.");
  }
  if ((row.stripe_mode !== "test" && row.stripe_mode !== "live") || !/^acct_[A-Za-z0-9]+$/.test(row.stripe_platform_account_id ?? "")) {
    throw new Error("This billing record needs an identity review before it can be used.");
  }
  return { mode: row.stripe_mode, platformAccountId: row.stripe_platform_account_id };
}

/** A mode switch never changes the identity partway through a request. */
export async function billingRequestIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!/^\/api\/(?:billing\/|patient-data\/billing(?:\/|$))/.test(req.path) ||
      /^\/api\/billing\/(?:webhooks\/|hq\/(?:health|mode)(?:\/|$)|oauth\/callback)/.test(req.path) ||
      req.path.includes("/product-images/")) { next(); return; }
  try {
    const reference = storedIdentityReference(req.path, req.query);
    const selected = reference ? await identityForReference(reference) : await getBillingModeStatus();
    const identity: BillingIdentity = { mode: selected.mode, platformAccountId: selected.platformAccountId };
    const credentials = await getStripeCredentials(identity.mode);
    if (credentials.account_id !== identity.platformAccountId) throw new Error("The original Stripe account is no longer configured.");
    const scope = `${identity.mode}:${identity.platformAccountId}`;
    res.setHeader("X-Billing-Scope", scope);
    res.setHeader("Cache-Control", "no-store");
    // New financial mutations require the identity displayed when the form was
    // loaded. Old clients fail closed instead of turning a test sale into live.
    const financialWrite = req.method !== "GET" && (
      /\/(?:checkout|setup)$/.test(req.path) ||
      /^\/api\/billing\/office\/sales(?:\/tap)?$/.test(req.path) ||
      req.path === "/api/patient-data/billing/cards"
    );
    const supplied = req.get("X-Billing-Scope");
    if ((!reference && financialWrite && supplied !== scope) || (supplied && supplied !== scope)) {
      res.status(409).json({ error: "Payment mode changed. Reload the payment screen before continuing.", code: "billing_scope_changed" }); return;
    }
    runWithBillingIdentity(identity, next);
  } catch {
    res.status(503).json({ error: "Payments are not configured for this record or environment.", code: "billing_not_configured" });
  }
}