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

export function thinnrSharePerUnit(floorCents: number): number {
  return Math.floor(floorCents * 60 / 100);
}

export function estimateStripeFee(totalCents: number, settings: Pick<FeeSettings, "card_fee_bps" | "card_fee_fixed_cents">): number {
  return Math.round(totalCents * settings.card_fee_bps / 10_000) + settings.card_fee_fixed_cents;
}

export function computeOrderFees(lines: FeeLine[], settings: FeeSettings) {
  const thinnr_share_cents = lines.reduce(
    (sum, line) => sum + thinnrSharePerUnit(line.floor_price_cents) * line.quantity,
    0,
  );
  return {
    thinnr_share_cents,
    shipping_charge_cents: settings.shipping_charge_cents,
    application_fee_cents: thinnr_share_cents + settings.shipping_charge_cents,
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
): number {
  return applicationFeeCents - hardCostCents - shippingCostCents;
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