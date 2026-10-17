export interface FeeSettings {
  shipping_charge_cents: number;
  shipping_cost_cents: number;
  card_fee_bps: number;
  card_fee_fixed_cents: number;
}

export interface FeeLine {
  floor_price_cents: number;
  quantity: number;
}

/**
 * THINNR's normal share of a product's floor price. Catalog economics (price
 * floors, break-even minimums, practice-launch pricing) are always quoted at
 * this share — an office narrowed for nonpayment pays a higher share on the
 * charges it takes, it does not get a different price list.
 */
export const NORMAL_THINNR_SHARE_PERCENT = 60;

export function thinnrSharePerUnit(floorCents: number, sharePercent: number = NORMAL_THINNR_SHARE_PERCENT): number {
  return Math.floor(floorCents * sharePercent / 100);
}

/**
 * THINNR's share of an app-access charge (the office's recurring fee for the
 * app's premium AI features). Unlike products there is no floor price: the
 * share is a flat percentage of whatever the office charges, snapshotted on
 * each order like the product share percent. There is no shipment to
 * recover, so the platform fee is exactly this share.
 */
export const APP_ACCESS_THINNR_SHARE_PERCENT = 30;

export function appAccessThinnrShare(priceCents: number, sharePercent: number = APP_ACCESS_THINNR_SHARE_PERCENT): number {
  return Math.floor(priceCents * sharePercent / 100);
}

export function estimateStripeFee(totalCents: number, settings: Pick<FeeSettings, "card_fee_bps" | "card_fee_fixed_cents">): number {
  return Math.round(totalCents * settings.card_fee_bps / 10_000) + settings.card_fee_fixed_cents;
}

/**
 * The platform fee = THINNR's floor share + what THINNR must recover for the
 * shipment. Legacy flat shipping recovers the flat charge; a rated shipment
 * recovers carrier cost + pick-and-pack + packaging (whatever the patient paid).
 *
 * `sharePercent` is the office's share at the moment of the charge: the normal
 * share, or the elevated one while the office is restricted for nonpayment.
 */
export function computeOrderFees(
  lines: FeeLine[],
  settings: FeeSettings,
  shippingRecoveryCents = settings.shipping_charge_cents,
  sharePercent: number = NORMAL_THINNR_SHARE_PERCENT,
) {
  const thinnr_share_cents = lines.reduce(
    (sum, line) => sum + thinnrSharePerUnit(line.floor_price_cents, sharePercent) * line.quantity,
    0,
  );
  return {
    thinnr_share_cents,
    shipping_charge_cents: settings.shipping_charge_cents,
    application_fee_cents: thinnr_share_cents + shippingRecoveryCents,
  };
}

function officeKeeps(sell: number, floor: number, settings: FeeSettings): number {
  const total = sell + settings.shipping_charge_cents;
  return total - (thinnrSharePerUnit(floor) + settings.shipping_charge_cents) -
    estimateStripeFee(total, settings);
}

export function breakEvenMinimum(floorCents: number, settings: FeeSettings): number {
  const share = thinnrSharePerUnit(floorCents);
  const denominator = 1 - settings.card_fee_bps / 10_000;
  let candidate = Math.max(0, Math.floor(
    (share + settings.card_fee_fixed_cents +
      settings.shipping_charge_cents * settings.card_fee_bps / 10_000) / denominator,
  ));
  while (officeKeeps(candidate, floorCents, settings) < 0) candidate += 1;
  while (candidate > 0 && officeKeeps(candidate - 1, floorCents, settings) >= 0) candidate -= 1;
  return candidate;
}

export function applicationFeePercentFor(exactFeeCents: number, invoiceTotalCents: number): number {
  if (invoiceTotalCents <= 0) return 0;
  return Math.min(100, Math.ceil(exactFeeCents * 10_000 / invoiceTotalCents) / 100);
}

export function hqProfit(
  applicationFeeCents: number,
  hardCostCents: number,
  shippingCostCents: number,
  fulfillmentFeeCents = 0,
): number {
  return applicationFeeCents - hardCostCents - shippingCostCents - fulfillmentFeeCents;
}

export function belowMinimum(sellPriceCents: number | null, floorCents: number, settings: FeeSettings): boolean {
  return sellPriceCents !== null && sellPriceCents < breakEvenMinimum(floorCents, settings);
}

export function officeNet(
  totalCents: number,
  applicationFeeCents: number,
  settings: FeeSettings,
  actualStripeFeeCents?: number | null,
): number {
  return totalCents - applicationFeeCents -
    (actualStripeFeeCents ?? estimateStripeFee(totalCents, settings));
}

export function applicationFeeOverCollection(collectedCents: number, exactCents: number): number {
  return Math.max(0, collectedCents - exactCents);
}