import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripeCustomerEmailsPatch } from "./accounts";

/**
 * THINNR sends every customer email itself. Stripe exposes no API for its
 * Dashboard "Customer emails" toggles, so the guarantee is structural: the
 * accounts THINNR creates have no Dashboard (nothing to turn on), accounts
 * with their own Dashboard are tracked until HQ confirms them, and no charge
 * ever asks Stripe for a receipt.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("Stripe customer emails stay off", () => {
  it("marks accounts without a Stripe Dashboard off by construction", () => {
    const patch = stripeCustomerEmailsPatch({ type: "custom" });
    expect(patch.stripe_customer_emails).toBe("off");
    expect(patch.stripe_customer_emails_checked_at).toBeTruthy();
  });
  it("leaves Dashboard-owning accounts unverified until HQ confirms, then keeps the confirmation across syncs", () => {
    const fresh = stripeCustomerEmailsPatch({ type: "standard" }, null);
    expect(fresh).toMatchObject({ stripe_customer_emails: "unverified", stripe_customer_emails_checked_at: null });
    expect(fresh.stripe_customer_emails_note).toContain("Customer emails");
    const confirmed = { stripe_customer_emails: "off" as const, stripe_customer_emails_checked_at: "2026-09-01T00:00:00.000Z", stripe_customer_emails_note: "Confirmed off." };
    expect(stripeCustomerEmailsPatch({ type: "standard" }, confirmed)).toEqual(confirmed);
    const reportedOn = { ...confirmed, stripe_customer_emails: "on" as const };
    expect(stripeCustomerEmailsPatch({ type: "express" }, reportedOn).stripe_customer_emails).toBe("on");
    // A stale unverified row is refreshed, not carried.
    expect(stripeCustomerEmailsPatch({ type: "standard" }, { stripe_customer_emails: "unverified", stripe_customer_emails_checked_at: null, stripe_customer_emails_note: null }).stripe_customer_emails).toBe("unverified");
  });
  it("never asks Stripe to email a receipt or invoice on THINNR's behalf", () => {
    const offenders = sources(path.join(__dirname, "..")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /receipt_email\s*:/.test(text) || /send_invoice/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
