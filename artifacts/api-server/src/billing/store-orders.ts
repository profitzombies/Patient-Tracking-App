import { supabaseAdmin } from "../lib/supabase-admin";
import { selectMany, selectOne, type BillingOrderItemRow, type BillingOrderRow, type BillingPayerRow } from "./store";

export type ProviderSummary = {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
};

export async function getProvider(providerId: string): Promise<ProviderSummary | null> {
  const result = await supabaseAdmin("GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=provider_id,office_name,provider_name,email,phone,city,state&limit=1`);
  if (result.status >= 300) throw new Error("Could not load the office.");
  return Array.isArray(result.json) ? result.json[0] ?? null : null;
}

export async function getOrderBundle(orderId: string): Promise<{
  order: BillingOrderRow; items: BillingOrderItemRow[]; payer: BillingPayerRow; office: ProviderSummary;
} | null> {
  const order = await selectOne("billing_orders", `id=eq.${encodeURIComponent(orderId)}`);
  if (!order) return null;
  const [items, payer, office] = await Promise.all([
    selectMany("billing_order_items", `order_id=eq.${encodeURIComponent(order.id)}&order=created_at.asc`),
    selectOne("billing_payers", `id=eq.${encodeURIComponent(order.payer_id)}`),
    getProvider(order.provider_id),
  ]);
  if (!payer || !office) throw new Error("Order details are incomplete.");
  return { order, items, payer, office };
}

export function officeName(office: ProviderSummary): string {
  return office.office_name?.trim() || office.provider_name?.trim() || "Office";
}