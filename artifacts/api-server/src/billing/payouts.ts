import { connectedOpts, getStripe } from "./stripe-client";
import { insertIgnore, nowIso, selectMany, selectOne, upsert } from "./store";
import type { Balance, PayoutRow } from "./types";
import { onStripeEvent } from "./webhooks";

export type BalanceResult = { balance: Balance | null; stale: boolean };
export async function getBalance(accountId: string): Promise<BalanceResult> {
  try {
    const balance = await (await getStripe()).balance.retrieve({}, connectedOpts(accountId));
    const sum = (rows: Array<{ amount: number; currency: string }>) =>
      rows.filter((row) => row.currency === "usd").reduce((total, row) => total + row.amount, 0);
    return { balance: { available_cents: sum(balance.available), pending_cents: sum(balance.pending) }, stale: false };
  } catch {
    return { balance: null, stale: true };
  }
}
function toRow(row: any): PayoutRow {
  return { id: row.id, stripe_payout_id: row.stripe_payout_id ?? row.id, amount_cents: row.amount_cents ?? row.amount,
    status: row.status, arrival_date: row.arrival_date ? (typeof row.arrival_date === "number" ? new Date(row.arrival_date * 1000).toISOString().slice(0, 10) : row.arrival_date) : null,
    method: row.method ?? null, created_at: typeof row.created === "number" ? new Date(row.created * 1000).toISOString() : row.created_at };
}
export async function listPayouts(accountId: string, providerId?: string): Promise<{ items: PayoutRow[]; stale: boolean }> {
  const mirrored = providerId ? await selectMany("billing_payouts", `provider_id=eq.${encodeURIComponent(providerId)}&order=created_at.desc&limit=50`) : [];
  try {
    const live = await (await getStripe()).payouts.list({ limit: 20 }, connectedOpts(accountId));
    const merged = new Map<string, PayoutRow>(mirrored.map((row) => [row.stripe_payout_id, toRow(row)]));
    for (const row of live.data) merged.set(row.id, toRow(row));
    return { items: [...merged.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)), stale: false };
  } catch {
    return { items: mirrored.map(toRow), stale: true };
  }
}
export async function mirrorPayout(providerId: string, payout: any): Promise<boolean> {
  const existing = await selectOne("billing_payouts", `stripe_payout_id=eq.${encodeURIComponent(payout.id)}`);
  await upsert("billing_payouts", {
    provider_id: providerId, stripe_payout_id: payout.id, amount_cents: payout.amount,
    status: payout.status,
    arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) : null,
    method: payout.method ?? null,
    created_at: payout.created ? new Date(payout.created * 1000).toISOString() : undefined,
  }, "stripe_payout_id");
  const debit = await selectOne("billing_ledger", `kind=eq.payout&stripe_ref=eq.${encodeURIComponent(payout.id)}`);
  if (payout.status === "paid" && !debit) {
    await insertIgnore("billing_ledger", {
      provider_id: providerId, order_id: null, subscription_id: null, kind: "payout",
      amount_cents: -payout.amount, application_fee_cents: 0, stripe_ref: payout.id,
      detail: { status: payout.status }, occurred_at: nowIso(),
    }, "billing_ledger_kind_stripe_ref_unique");
  } else if ((payout.status === "failed" || payout.status === "canceled") && debit) {
    await insertIgnore("billing_ledger", {
      provider_id: providerId, order_id: null, subscription_id: null, kind: "payout",
      amount_cents: payout.amount, application_fee_cents: 0, stripe_ref: `${payout.id}:reversal`,
      detail: { status: payout.status }, occurred_at: nowIso(),
    }, "billing_ledger_kind_stripe_ref_unique");
  }
  return !existing;
}
export function registerPayoutWebhookHandlers(): void {
  const handler = async (event: any, ctx: { account: string | null }) => {
    const payout = event.data.object;
    if (!ctx.account) return;
    const account = await selectOne("billing_connected_accounts", `stripe_account_id=eq.${encodeURIComponent(ctx.account)}`);
    if (!account) return;
    await mirrorPayout(account.provider_id, payout);
  };
  onStripeEvent("payout.paid", handler);
  onStripeEvent("payout.failed", handler);
  onStripeEvent("payout.canceled", handler);
}
