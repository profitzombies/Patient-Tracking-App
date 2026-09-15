import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";
import { detectThumbnailContentType, objectStorage, ObjectNotFoundError, THUMBNAIL_CONTENT_TYPES, UPLOAD_URL_TTL_SEC } from "../lib/objectStorage";
import { belowMinimum, breakEvenMinimum, hqProfit, thinnrSharePerUnit, type FeeSettings } from "./fees";
import {
  insert, remove, selectMany, selectOne, update,
  type BillingProductImageRow, type BillingProductRow, type BillingProductStatus, type BillingSettingsRow,
} from "./store";
import type {
  BillingSettings, CatalogChange, CatalogChangeKind, CatalogProduct, CatalogProductDetail, CatalogProductInput,
  HqCatalogResponse, ProductImage, PublicLinkProduct,
} from "./types";

export class BillingCatalogError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
export const MAX_PRODUCT_IMAGES = 5;
export const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_HEAD_BYTES = 64 * 1024;
const PRODUCT_STATUSES: BillingProductStatus[] = ["draft", "active", "retired", "archived"];
const enc = encodeURIComponent;

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
/** Open redirect route that resolves to a short-lived signed URL (see billing-public). */
export function productImageUrl(imageId: string): string { return `/api/billing/public/product-images/${imageId}`; }
export function imageDto(row: BillingProductImageRow): ProductImage {
  return {
    id: row.id, url: productImageUrl(row.id), content_type: row.content_type, size_bytes: row.size_bytes,
    sort_order: row.sort_order, is_default: row.is_default, created_at: row.created_at,
  };
}
/** Default image per product id: the flagged default, else the first by sort order. */
export function defaultImages(images: BillingProductImageRow[]): Map<string, BillingProductImageRow> {
  const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  const out = new Map<string, BillingProductImageRow>();
  for (const image of sorted) {
    const current = out.get(image.product_id);
    if (!current || (image.is_default && !current.is_default)) out.set(image.product_id, image);
  }
  return out;
}
export async function loadDefaultImages(): Promise<Map<string, BillingProductImageRow>> {
  return defaultImages(await selectMany("billing_product_images", "order=sort_order.asc"));
}

/** The single payer-facing offering builder shared by public and patient checkout reads. */
export async function officeOffering(providerId: string): Promise<PublicLinkProduct[]> {
  const [prices, products, images] = await Promise.all([
    selectMany("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}`),
    selectMany("billing_products", "active=eq.true"),
    loadDefaultImages(),
  ]);
  const productMap = new Map(products.map((product) => [product.id, product]));
  return prices.flatMap((price) => {
    const product = productMap.get(price.product_id);
    const image = images.get(price.product_id);
    return product ? [{
      product_id: product.id,
      name: product.name,
      description: product.description ?? "",
      image_url: image ? productImageUrl(image.id) : null,
      unit_price_cents: price.sell_price_cents,
      subscription_available: price.subscription_enabled,
    }] : [];
  });
}

/** Every catalog write lands one audit row; office price changes ride the same table. */
export async function recordCatalogChange(input: {
  productId: string | null; kind: CatalogChangeKind; before: Record<string, unknown> | null;
  after: Record<string, unknown> | null; actor: string; providerId?: string | null;
}) {
  await insert("billing_catalog_changes", {
    product_id: input.productId, kind: input.kind, before: input.before, after: input.after,
    actor_user_id: input.actor, provider_id: input.providerId ?? null,
  });
}
const change = (productId: string | null, kind: CatalogChangeKind, before: Record<string, unknown> | null, after: Record<string, unknown> | null, actor: string) =>
  recordCatalogChange({ productId, kind, before, after, actor });
const snapshot = (row: BillingProductRow): Record<string, unknown> => ({
  slug: row.slug, name: row.name, description: row.description, floor_price_cents: row.floor_price_cents,
  hard_cost_cents: row.hard_cost_cents, status: row.status, sort_order: row.sort_order,
});

function productDto(
  product: BillingProductRow, settings: BillingSettingsRow,
  prices: { product_id: string; sell_price_cents: number }[], images: BillingProductImageRow[],
): CatalogProduct {
  const offered = prices.filter((price) => price.product_id === product.id);
  const minimum = breakEvenMinimum(product.floor_price_cents, feeSettings(settings));
  const officesBelow = offered.filter((price) => belowMinimum(price.sell_price_cents, product.floor_price_cents, feeSettings(settings))).length;
  const share = thinnrSharePerUnit(product.floor_price_cents);
  const fallback = defaultImages(images).get(product.id);
  return {
    id: product.id, slug: product.slug, name: product.name, description: product.description ?? "",
    floor_price_cents: product.floor_price_cents, hard_cost_cents: product.hard_cost_cents,
    active: product.active, status: product.status, retired_at: product.retired_at, archived_at: product.archived_at ?? null,
    image_url: fallback ? productImageUrl(fallback.id) : null, image_count: images.length, updated_at: product.updated_at ?? product.created_at,
    sort_order: product.sort_order, thinnr_share_cents: share, break_even_minimum_cents: minimum,
    hq_profit_per_unit_cents: hqProfit(share, product.hard_cost_cents, 0),
    offices_offering: offered.length, offices_below_minimum: officesBelow,
  };
}
export async function listCatalog(): Promise<HqCatalogResponse> {
  const [settings, products, prices, images] = await Promise.all([
    getSettings(), selectMany("billing_products", "order=sort_order.asc,name.asc"),
    selectMany("billing_office_prices", "select=provider_id,product_id,sell_price_cents"),
    selectMany("billing_product_images", "order=sort_order.asc"),
  ]);
  const mapped = products.map((product) => productDto(product, settings, prices, images.filter((image) => image.product_id === product.id)));
  return { products: mapped, settings: settingsDto(settings), offices_below_minimum: mapped.reduce((sum, product) => sum + product.offices_below_minimum, 0) };
}
async function requireProduct(id: string): Promise<BillingProductRow> {
  const row = await selectOne("billing_products", `id=eq.${enc(id)}`);
  if (!row) throw new BillingCatalogError("Product not found.", 404);
  return row;
}
export async function getProduct(id: string): Promise<CatalogProductDetail> {
  const product = await requireProduct(id);
  const [settings, prices, images] = await Promise.all([
    getSettings(), selectMany("billing_office_prices", `product_id=eq.${enc(id)}&select=provider_id,product_id,sell_price_cents`),
    selectMany("billing_product_images", `product_id=eq.${enc(id)}&order=sort_order.asc,created_at.asc`),
  ]);
  return { ...productDto(product, settings, prices, images), images: images.map(imageDto) };
}
export async function createProduct(input: CatalogProductInput, actor: string): Promise<CatalogProductDetail> {
  const slug = (input.slug?.trim() || slugify(input.name));
  if (!slug) throw new BillingCatalogError("Enter a product name.", 400, "name");
  const { status = "active", sort_order, ...values } = input;
  let order = sort_order;
  if (order === undefined) {
    const last = await selectMany("billing_products", "select=sort_order&order=sort_order.desc&limit=1");
    order = (last[0]?.sort_order ?? 0) + 1;
  }
  const row = await insert("billing_products", {
    ...values, description: input.description ?? "", slug, status, active: status === "active",
    retired_at: null, archived_at: null, sort_order: order,
  });
  await change(row.id, "product_created", null, snapshot(row), actor);
  return getProduct(row.id);
}
export async function editProduct(id: string, input: Partial<CatalogProductInput>, actor: string): Promise<CatalogProductDetail> {
  const before = await requireProduct(id);
  const { status: _status, ...values } = input;
  if (Object.keys(values).length) {
    const after = await update("billing_products", `id=eq.${enc(id)}`, values);
    if (!after) throw new BillingCatalogError("Product not found.", 404);
    await change(id, "product_updated", snapshot(before), snapshot(after), actor);
  }
  return getProduct(id);
}
function statusChangeKind(from: BillingProductStatus, to: BillingProductStatus): CatalogChangeKind {
  if (to === "archived") return "product_archived";
  if (to === "retired") return "product_retired";
  if (from === "archived") return "product_unarchived";
  if (to === "active") return from === "retired" ? "product_reactivated" : "product_published";
  return "product_updated";
}
/** Lifecycle: draft -> active -> retired, archived from anywhere, unarchive back to draft or active. */
export async function setProductStatus(id: string, status: BillingProductStatus, actor: string): Promise<CatalogProductDetail> {
  if (!PRODUCT_STATUSES.includes(status)) throw new BillingCatalogError("Choose a valid status.", 400, "status");
  const before = await requireProduct(id);
  if (before.status !== status) {
    const now = new Date().toISOString();
    const after = await update("billing_products", `id=eq.${enc(id)}`, {
      status, active: status === "active",
      retired_at: status === "retired" ? now : status === "archived" ? before.retired_at : null,
      archived_at: status === "archived" ? now : null,
    });
    if (!after) throw new BillingCatalogError("Product not found.", 404);
    await change(id, statusChangeKind(before.status, status), snapshot(before), snapshot(after), actor);
  }
  return getProduct(id);
}
/** Kept for the older retire/reactivate routes. */
export async function setProductActive(id: string, active: boolean, actor: string): Promise<CatalogProductDetail> {
  return setProductStatus(id, active ? "active" : "retired", actor);
}
/** Re-number every product by the given order; ids not listed keep their relative order after them. */
export async function reorderProducts(ids: string[], actor: string): Promise<CatalogProduct[]> {
  const products = await selectMany("billing_products", "order=sort_order.asc,name.asc");
  const known = new Set(products.map((product) => product.id));
  const listed = ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index);
  if (listed.length !== ids.length) throw new BillingCatalogError("The product list is out of date. Refresh and try again.", 409);
  const ordered = [...listed, ...products.filter((product) => !listed.includes(product.id)).map((product) => product.id)];
  const before = products.map((product) => product.slug);
  for (const [index, id] of ordered.entries()) {
    const current = products.find((product) => product.id === id);
    if (current && current.sort_order === index + 1) continue;
    await update("billing_products", `id=eq.${enc(id)}`, { sort_order: index + 1 });
  }
  const after = ordered.map((id) => products.find((product) => product.id === id)?.slug ?? id);
  if (before.join("|") !== after.join("|")) await change(null, "products_reordered", { order: before }, { order: after }, actor);
  return (await listCatalog()).products;
}

// ---------- images ----------
async function productImages(productId: string): Promise<BillingProductImageRow[]> {
  return selectMany("billing_product_images", `product_id=eq.${enc(productId)}&order=sort_order.asc,created_at.asc`);
}
export async function productImageUploadUrl(productId: string, input: { content_type: string; size: number }, actor: string) {
  await requireProduct(productId);
  if (!THUMBNAIL_CONTENT_TYPES.has(input.content_type)) throw new BillingCatalogError("Use a JPEG, PNG, or WebP image.", 415, "image");
  if (!Number.isInteger(input.size) || input.size < 1) throw new BillingCatalogError("Check the image file.", 400, "image");
  if (input.size > MAX_PRODUCT_IMAGE_BYTES) throw new BillingCatalogError("Images must be 10 MB or smaller.", 413, "image");
  const existing = await productImages(productId);
  if (existing.length >= MAX_PRODUCT_IMAGES) throw new BillingCatalogError(`Each product can have up to ${MAX_PRODUCT_IMAGES} images.`, 409, "image");
  const imageId = randomUUID();
  const upload = await objectStorage.productImageUploadURL(productId, imageId);
  void actor;
  return { image_id: imageId, upload_url: upload.uploadUrl, object_path: upload.objectPath, expires_in: UPLOAD_URL_TTL_SEC };
}
export async function finalizeProductImage(
  productId: string, input: { image_id: string; object_path: string; content_type: string; size: number }, actor: string,
): Promise<CatalogProductDetail> {
  await requireProduct(productId);
  if (!/^[0-9a-f-]{36}$/i.test(input.image_id) || input.object_path !== `/objects/product-images/${productId}/${input.image_id}`) {
    throw new BillingCatalogError("That upload does not belong to this product.", 400, "image");
  }
  // A retried finalize (network blip after the row landed) must answer with
  // the saved product, never re-run the checks that discard the object.
  const already = await selectOne("billing_product_images", `id=eq.${enc(input.image_id)}&product_id=eq.${enc(productId)}`);
  if (already) return getProduct(productId);
  const discard = async () => { try { await objectStorage.deleteObjectStrict(input.object_path); } catch { /* best effort */ } };
  if (!THUMBNAIL_CONTENT_TYPES.has(input.content_type) || input.size > MAX_PRODUCT_IMAGE_BYTES) {
    await discard();
    throw new BillingCatalogError("Use a JPEG, PNG, or WebP image up to 10 MB.", 415, "image");
  }
  let file;
  try { file = await objectStorage.entityFile(input.object_path); }
  catch (error) {
    if (error instanceof ObjectNotFoundError) throw new BillingCatalogError("The image upload did not finish. Try again.", 409, "image");
    throw error;
  }
  const [metadata] = await file.getMetadata();
  const actualSize = Number(metadata.size ?? 0);
  if (actualSize !== input.size || actualSize < 1 || actualSize > MAX_PRODUCT_IMAGE_BYTES) {
    await discard();
    throw new BillingCatalogError("The uploaded image does not match its declared details.", 422, "image");
  }
  const [head] = await file.download({ start: 0, end: IMAGE_HEAD_BYTES - 1 });
  if (detectThumbnailContentType(Buffer.from(head)) !== input.content_type) {
    await discard();
    throw new BillingCatalogError("The uploaded file is not a valid image.", 422, "image");
  }
  const existing = await productImages(productId);
  if (existing.length >= MAX_PRODUCT_IMAGES) {
    await discard();
    throw new BillingCatalogError(`Each product can have up to ${MAX_PRODUCT_IMAGES} images.`, 409, "image");
  }
  await file.setMetadata({ contentType: input.content_type, cacheControl: "private, max-age=3600" });
  const row = await insert("billing_product_images", {
    id: input.image_id, product_id: productId, object_path: input.object_path, content_type: input.content_type,
    size_bytes: actualSize, sort_order: (existing.at(-1)?.sort_order ?? 0) + 1, is_default: existing.length === 0, created_by: actor,
  });
  await change(productId, "product_image_added", null, { image_id: row.id, is_default: row.is_default, size_bytes: row.size_bytes }, actor);
  return getProduct(productId);
}
export async function removeProductImage(productId: string, imageId: string, actor: string): Promise<CatalogProductDetail> {
  await requireProduct(productId);
  const image = await selectOne("billing_product_images", `id=eq.${enc(imageId)}&product_id=eq.${enc(productId)}`);
  if (!image) throw new BillingCatalogError("Image not found.", 404);
  await remove("billing_product_images", `id=eq.${enc(imageId)}`);
  await objectStorage.deleteObject(image.object_path);
  if (image.is_default) {
    const next = (await productImages(productId))[0];
    if (next) await update("billing_product_images", `id=eq.${enc(next.id)}`, { is_default: true });
  }
  await change(productId, "product_image_removed", { image_id: image.id, is_default: image.is_default }, null, actor);
  return getProduct(productId);
}
export async function setDefaultProductImage(productId: string, imageId: string, actor: string): Promise<CatalogProductDetail> {
  await requireProduct(productId);
  const images = await productImages(productId);
  const target = images.find((image) => image.id === imageId);
  if (!target) throw new BillingCatalogError("Image not found.", 404);
  const previous = images.find((image) => image.is_default);
  if (previous?.id !== imageId) {
    if (previous) await update("billing_product_images", `id=eq.${enc(previous.id)}`, { is_default: false });
    await update("billing_product_images", `id=eq.${enc(imageId)}`, { is_default: true });
    await change(productId, "product_default_image", previous ? { image_id: previous.id } : null, { image_id: imageId }, actor);
  }
  return getProduct(productId);
}
/** Open read: resolve an image id to its signed object URL (null when unknown). */
export async function productImageSignedUrl(imageId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) return null;
  const image = await selectOne("billing_product_images", `id=eq.${enc(imageId)}`);
  if (!image) return null;
  return objectStorage.signedDownloadURL(image.object_path, 3600);
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
  const rows = await selectMany("billing_catalog_changes", "order=created_at.desc&limit=300");
  const productIds = [...new Set(rows.flatMap((row) => row.product_id ? [row.product_id] : []))];
  const users = [...new Set(rows.flatMap((row) => row.actor_user_id ? [row.actor_user_id] : []))];
  const offices = [...new Set(rows.flatMap((row) => row.provider_id ? [row.provider_id] : []))];
  const list = (values: string[]) => `in.(${values.map(enc).join(",")})`;
  const rowsOf = (result: { status: number; json: unknown } | null) => (result && result.status < 300 && Array.isArray(result.json) ? result.json as Record<string, unknown>[] : []);
  const [products, memberships, profiles, providers] = await Promise.all([
    productIds.length ? selectMany("billing_products", `id=${list(productIds)}&select=id,name`) : [],
    users.length ? supabaseAdmin("GET", `/rest/v1/hq_memberships?auth_user_id=${list(users)}&select=id,auth_user_id,display_name`) : null,
    users.length ? supabaseAdmin("GET", `/rest/v1/profiles?id=${list(users)}&select=id,full_name`) : null,
    offices.length ? supabaseAdmin("GET", `/rest/v1/providers?provider_id=${list(offices)}&select=provider_id,office_name,provider_name`) : null,
  ]);
  const names = new Map<string, string>();
  const memberIds = new Map<string, string>();
  for (const row of rowsOf(memberships)) if (row.id) memberIds.set(String(row.auth_user_id), String(row.id));
  for (const row of rowsOf(profiles)) if (typeof row.full_name === "string" && row.full_name.trim()) names.set(String(row.id), row.full_name.trim());
  // The HQ roster display name wins: that is the name shown on the Team page the history links to.
  for (const row of rowsOf(memberships)) if (typeof row.display_name === "string" && row.display_name.trim()) names.set(String(row.auth_user_id), row.display_name.trim());
  const officeNames = new Map(rowsOf(providers).map((row) => [String(row.provider_id), String(row.office_name ?? row.provider_name ?? "").trim() || "Office"]));
  return rows.map((row) => ({
    id: row.id, product_id: row.product_id,
    product_name: products.find((product) => product.id === row.product_id)?.name ?? null,
    kind: row.kind as CatalogChange["kind"], before: row.before, after: row.after,
    actor_user_id: row.actor_user_id, actor_name: row.actor_user_id ? names.get(row.actor_user_id) ?? null : null,
    actor_member_id: row.actor_user_id ? memberIds.get(row.actor_user_id) ?? null : null,
    provider_id: row.provider_id ?? null, office_name: row.provider_id ? officeNames.get(row.provider_id) ?? null : null,
    created_at: row.created_at,
  }));
}
