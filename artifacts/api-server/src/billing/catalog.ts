import { supabaseAdmin } from "../lib/supabase-admin";
import { belowMinimum, breakEvenMinimum, hqProfit, thinnrSharePerUnit, type FeeSettings } from "./fees";
import { insert, selectMany, selectOne, update, type BillingProductRow, type BillingSettingsRow } from "./store";
import type { BillingSettings, CatalogChange, CatalogProduct, CatalogProductInput, HqCatalogResponse } from "./types";

export class BillingCatalogError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
function settingsDto(row: BillingSettingsRow): BillingSettings {
  return {
    shipping_charge_cents: row.shipping_charge_cents, shipping_cost_cents: row.shipping_cost_cents,
    card_fee_bps: row.card_fee_bps, card_fee_fixed_cents: row.card_fee_fixed_cents,
    version: row.version, updated_at: row.updated_at ?? null,
  };
}
export async function getSettings(): Promise<BillingSettingsRow> {
  const row = await selectOne("billing_settings", "id=eq.1");
  if (!row) throw new BillingCatalogError("Billing settings are unavailable.", 503);
  return row;
}
function feeSettings(row: BillingSettingsRow): FeeSettings { return row; }
function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
async function change(productId: string | null, kind: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, actor: string) {
  await insert("billing_catalog_changes", { product_id: productId, kind, before, after, actor_user_id: actor });
}
export async function listCatalog(): Promise<HqCatalogResponse> {
  const [settings, products, prices] = await Promise.all([
    getSettings(), selectMany("billing_products", "order=sort_order.asc,name.asc"),
    selectMany("billing_office_prices", "select=provider_id,product_id,sell_price_cents"),
  ]);
  let totalBelow = 0;
  const mapped: CatalogProduct[] = products.map((product) => {
    const offered = prices.filter((price) => price.product_id === product.id);
    const minimum = breakEvenMinimum(product.floor_price_cents, feeSettings(settings));
    const officesBelow = offered.filter((price) => belowMinimum(price.sell_price_cents, product.floor_price_cents, feeSettings(settings))).length;
    totalBelow += officesBelow;
    const share = thinnrSharePerUnit(product.floor_price_cents);
    return {
      id: product.id, slug: product.slug, name: product.name, floor_price_cents: product.floor_price_cents,
      hard_cost_cents: product.hard_cost_cents, active: product.active, retired_at: product.retired_at,
      sort_order: product.sort_order, thinnr_share_cents: share, break_even_minimum_cents: minimum,
      hq_profit_per_unit_cents: hqProfit(share, product.hard_cost_cents, 0),
      offices_offering: offered.length, offices_below_minimum: officesBelow,
    };
  });
  return { products: mapped, settings: settingsDto(settings), offices_below_minimum: totalBelow };
}
export async function createProduct(input: CatalogProductInput, actor: string): Promise<BillingProductRow> {
  const slug = (input.slug?.trim() || slugify(input.name));
  if (!slug) throw new BillingCatalogError("Enter a product name.", 400, "name");
  const row = await insert("billing_products", {
    ...input, slug, active: true, retired_at: null, sort_order: input.sort_order ?? 0,
  });
  await change(row.id, "product_created", null, row as unknown as Record<string, unknown>, actor);
  return row;
}
export async function editProduct(id: string, input: Partial<CatalogProductInput>, actor: string): Promise<BillingProductRow> {
  const before = await selectOne("billing_products", `id=eq.${encodeURIComponent(id)}`);
  if (!before) throw new BillingCatalogError("Product not found.", 404);
  const after = await update("billing_products", `id=eq.${encodeURIComponent(id)}`, input);
  if (!after) throw new BillingCatalogError("Product not found.", 404);
  await change(id, "product_updated", before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, actor);
  return after;
}
export async function setProductActive(id: string, active: boolean, actor: string): Promise<BillingProductRow> {
  const before = await selectOne("billing_products", `id=eq.${encodeURIComponent(id)}`);
  if (!before) throw new BillingCatalogError("Product not found.", 404);
  const after = await update("billing_products", `id=eq.${encodeURIComponent(id)}`, {
    active, retired_at: active ? null : new Date().toISOString(),
  });
  if (!after) throw new BillingCatalogError("Product not found.", 404);
  await change(id, active ? "product_reactivated" : "product_retired", before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, actor);
  return after;
}
export async function updateSettings(
  input: Pick<BillingSettingsRow, "shipping_charge_cents" | "shipping_cost_cents" | "card_fee_bps" | "card_fee_fixed_cents"> & { expected_version: number },
  actor: string,
): Promise<BillingSettings> {
  const before = await getSettings();
  if (before.version !== input.expected_version) throw new BillingCatalogError("Billing settings changed. Refresh and try again.", 409);
  const { expected_version, ...values } = input;
  const result = await supabaseAdmin("PATCH", `/rest/v1/billing_settings?id=eq.1&version=eq.${expected_version}`, {
    ...values, version: expected_version + 1, updated_by: actor,
  }, "return=representation");
  const after = Array.isArray(result.json) ? result.json[0] as BillingSettingsRow | undefined : undefined;
  if (result.status >= 300 || !after) throw new BillingCatalogError("Billing settings changed. Refresh and try again.", 409);
  await change(null, "settings_updated", before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, actor);
  return settingsDto(after);
}
export async function listCatalogChanges(): Promise<CatalogChange[]> {
  const rows = await selectMany("billing_catalog_changes", "order=created_at.desc&limit=200");
  const productIds = [...new Set(rows.flatMap((row) => row.product_id ? [row.product_id] : []))];
  const users = [...new Set(rows.flatMap((row) => row.actor_user_id ? [row.actor_user_id] : []))];
  const products: BillingProductRow[] = productIds.length
    ? await selectMany("billing_products", `id=in.(${productIds.map(encodeURIComponent).join(",")})`) : [];
  const profiles = users.length
    ? await supabaseAdmin("GET", `/rest/v1/profiles?id=in.(${users.map(encodeURIComponent).join(",")})&select=id,full_name`) : null;
  const names = new Map((Array.isArray(profiles?.json) ? profiles.json : []).map((row: { id: string; full_name?: string }) => [row.id, row.full_name ?? null]));
  return rows.map((row) => ({
    id: row.id, product_id: row.product_id,
    product_name: products.find((product) => product.id === row.product_id)?.name ?? null,
    kind: row.kind as CatalogChange["kind"], before: row.before, after: row.after,
    actor_user_id: row.actor_user_id, actor_name: row.actor_user_id ? names.get(row.actor_user_id) ?? null : null,
    created_at: row.created_at,
  }));
}