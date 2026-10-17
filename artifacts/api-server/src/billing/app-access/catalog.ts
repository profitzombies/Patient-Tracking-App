/**
 * The one "app access" catalog row. It is seeded inactive by the migration so
 * every storefront, price list and setup-wizard query (all keyed on `active`)
 * leaves it alone; subscriptions reference it by this fixed id.
 */
export const APP_ACCESS_PRODUCT_ID = "a99acce5-0000-4000-8000-000000000001";
export const APP_ACCESS_PRODUCT_SLUG = "app-access";
export const APP_ACCESS_PRODUCT_NAME = "THINNR app premium features";

export function isAppAccessProduct(row: { kind?: string | null; id?: string; slug?: string } | null | undefined): boolean {
  return row?.kind === "app_access" || row?.id === APP_ACCESS_PRODUCT_ID || row?.slug === APP_ACCESS_PRODUCT_SLUG;
}

/** True for subscription rows that bill app access rather than a product (legacy fakes may lack `kind`). */
export function isAppAccessSubscription(row: { kind?: string | null; product_id?: string } | null | undefined): boolean {
  return row?.kind === "app_access" || row?.product_id === APP_ACCESS_PRODUCT_ID;
}
