/**
 * Shipping & handling rules: NovEx pick-and-pack fee math plus the one server-side
 * rater every checkout path uses (patient app, in-office sales, public carts, renewals).
 *
 * Patient "Shipping & handling":
 *   live  = WarehouseCraft rate for the method + (office passes the fee through ? pick-and-pack + packaging : 0)
 *   fallback = the flat HQ charge, exactly (HQ's all-in number when rating is unavailable; nothing is added to it).
 *   Standard is free when HQ set a threshold and the shipment's item subtotal reaches it; expedited never is.
 * THINNR always incurs carrier cost + pick-and-pack + packaging, so `thinnr_shipping_cost_cents` is
 * what the platform fee must recover regardless of what the patient paid.
 */
import type { ShippingAddress } from "../billing/types";
import {
  buildRateRequest, fetchShippingRates, pickRate, WarehouseCraftError,
  type RateFetcher, type RateLine, type RateQuoteResult, type ShippingMethod,
} from "./warehousecraft";

export type { ShippingMethod } from "./warehousecraft";
export type PickPackTier = "under_50" | "from_51" | "from_100" | "from_250" | "from_500" | "from_1500";
export const PICK_PACK_TIERS: PickPackTier[] = ["under_50", "from_51", "from_100", "from_250", "from_500", "from_1500"];
export const SHIPPING_METHODS: ShippingMethod[] = ["standard", "expedited"];

export interface PickPackSchedule {
  /** One per shipment, by THINNR's weekly order-volume tier (NovEx proposal, D2C). */
  order_fee_cents: Record<PickPackTier, number>;
  unit_cents: number;
  oversized_unit_cents: number;
  /** Added per unit heavier than the threshold. */
  overweight_pick_cents: number;
  overweight_threshold_lb: number;
  /** Per-shipment packaging allowance (proposal: cost + 10%, TBD). */
  packaging_cents: number;
}

/** Seeded from the NovEx pricing proposal; the live values are the HQ-edited schedule. */
export const DEFAULT_PICK_PACK_SCHEDULE: PickPackSchedule = {
  order_fee_cents: { under_50: 495, from_51: 425, from_100: 395, from_250: 345, from_500: 295, from_1500: 175 },
  unit_cents: 25, oversized_unit_cents: 75, overweight_pick_cents: 200, overweight_threshold_lb: 30, packaging_cents: 0,
};

export interface ShippingRuleSettings {
  shipping_charge_cents: number;
  shipping_cost_cents: number;
  free_shipping_over_cents: number | null;
  pick_pack_tier: PickPackTier;
  pick_pack_schedule: PickPackSchedule;
  pick_pack_pass_through_default: boolean;
  expedited_enabled: boolean;
}

export interface FulfillmentLine {
  product_id: string;
  name: string;
  sku: string | null;
  quantity: number;
  weight_oz: number | null;
  oversized: boolean;
  unit_price_cents: number;
}

export interface PickPackBreakdown {
  order_fee_cents: number;
  unit_fee_cents: number;
  overweight_fee_cents: number;
  /** order + unit + overweight (packaging is separate). */
  pick_pack_fee_cents: number;
  packaging_cents: number;
  units: number;
  oversized_units: number;
  overweight_units: number;
}

export type ShippingSource = "live" | "fallback";
export type FallbackReason = "no_address" | "missing_weight" | "rating_unavailable" | "no_rate_for_method" | "expedited_disabled";

export interface ShipmentQuote {
  method: ShippingMethod;
  source: ShippingSource;
  fallback_reason: FallbackReason | null;
  /** What the patient pays for this shipment's Shipping & handling line. */
  patient_amount_cents: number;
  /** Carrier price THINNR pays (live) or the flat HQ shipping cost (fallback). */
  carrier_cost_cents: number;
  carrier_service_name: string | null;
  pick_pack_fee_cents: number;
  packaging_cents: number;
  pick_pack_passed_through: boolean;
  free_shipping_applied: boolean;
  /** Calendar dates (YYYY-MM-DD); null on fallback. */
  delivery_window_start: string | null;
  delivery_window_end: string | null;
  /** carrier_cost + pick_pack + packaging: what the platform fee must recover. */
  thinnr_shipping_cost_cents: number;
}

export interface ShipmentOptions {
  standard: ShipmentQuote;
  /** null when HQ turned expedited off. */
  expedited: ShipmentQuote | null;
}

export class ShippingAddressError extends Error {
  readonly status = 422;
}

const OZ_PER_LB = 16;

export function normalizeSchedule(raw: unknown): PickPackSchedule {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof PickPackSchedule, unknown>>;
  const cents = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback);
  const fees = (source.order_fee_cents && typeof source.order_fee_cents === "object" ? source.order_fee_cents : {}) as Record<string, unknown>;
  const order_fee_cents = Object.fromEntries(
    PICK_PACK_TIERS.map((tier) => [tier, cents(fees[tier], DEFAULT_PICK_PACK_SCHEDULE.order_fee_cents[tier])]),
  ) as Record<PickPackTier, number>;
  const threshold = typeof source.overweight_threshold_lb === "number" && source.overweight_threshold_lb > 0
    ? source.overweight_threshold_lb : DEFAULT_PICK_PACK_SCHEDULE.overweight_threshold_lb;
  return {
    order_fee_cents,
    unit_cents: cents(source.unit_cents, DEFAULT_PICK_PACK_SCHEDULE.unit_cents),
    oversized_unit_cents: cents(source.oversized_unit_cents, DEFAULT_PICK_PACK_SCHEDULE.oversized_unit_cents),
    overweight_pick_cents: cents(source.overweight_pick_cents, DEFAULT_PICK_PACK_SCHEDULE.overweight_pick_cents),
    overweight_threshold_lb: threshold,
    packaging_cents: cents(source.packaging_cents, DEFAULT_PICK_PACK_SCHEDULE.packaging_cents),
  };
}

export function isPickPackTier(value: unknown): value is PickPackTier {
  return typeof value === "string" && (PICK_PACK_TIERS as string[]).includes(value);
}

/** The tier the proposal's weekly-volume bands put a trailing-7-day paid-order count in (shown as an HQ hint only). */
export function suggestedTier(weeklyOrders: number): PickPackTier {
  if (weeklyOrders >= 1500) return "from_1500";
  if (weeklyOrders >= 500) return "from_500";
  if (weeklyOrders >= 250) return "from_250";
  if (weeklyOrders >= 100) return "from_100";
  if (weeklyOrders >= 51) return "from_51";
  return "under_50";
}

/** Pure fee math per shipment (NovEx D2C pick-and-pack schedule). */
export function computePickPackFee(lines: FulfillmentLine[], schedule: PickPackSchedule, tier: PickPackTier): PickPackBreakdown {
  const thresholdOz = schedule.overweight_threshold_lb * OZ_PER_LB;
  let units = 0; let oversized_units = 0; let overweight_units = 0; let unit_fee_cents = 0;
  for (const line of lines) {
    units += line.quantity;
    if (line.oversized) { oversized_units += line.quantity; unit_fee_cents += schedule.oversized_unit_cents * line.quantity; }
    else unit_fee_cents += schedule.unit_cents * line.quantity;
    if (line.weight_oz !== null && line.weight_oz > thresholdOz) overweight_units += line.quantity;
  }
  const order_fee_cents = schedule.order_fee_cents[tier];
  const overweight_fee_cents = overweight_units * schedule.overweight_pick_cents;
  return {
    order_fee_cents, unit_fee_cents, overweight_fee_cents,
    pick_pack_fee_cents: order_fee_cents + unit_fee_cents + overweight_fee_cents,
    packaging_cents: schedule.packaging_cents, units, oversized_units, overweight_units,
  };
}

/** Office override wins when set; null inherits HQ's default. */
export function resolvePassThrough(settings: Pick<ShippingRuleSettings, "pick_pack_pass_through_default">, officeOverride: boolean | null | undefined): boolean {
  return officeOverride ?? settings.pick_pack_pass_through_default;
}

function freeStandard(settings: ShippingRuleSettings, subtotalCents: number): boolean {
  return settings.free_shipping_over_cents !== null && subtotalCents >= settings.free_shipping_over_cents;
}

interface QuoteInputs {
  lines: FulfillmentLine[];
  subtotal_cents: number;
  settings: ShippingRuleSettings;
  pass_through: boolean;
}

function assemble(
  inputs: QuoteInputs, method: ShippingMethod, carrier: { cost: number; service: string | null; start: string | null; end: string | null } | null, reason: FallbackReason | null,
): ShipmentQuote {
  const fee = computePickPackFee(inputs.lines, inputs.settings.pick_pack_schedule, inputs.settings.pick_pack_tier);
  const live = carrier !== null;
  const handling = live && inputs.pass_through ? fee.pick_pack_fee_cents + fee.packaging_cents : 0;
  const carrierComponent = live ? carrier.cost : inputs.settings.shipping_charge_cents;
  const carrierCost = live ? carrier.cost : inputs.settings.shipping_cost_cents;
  const free = method === "standard" && freeStandard(inputs.settings, inputs.subtotal_cents);
  return {
    method, source: live ? "live" : "fallback", fallback_reason: live ? null : reason,
    patient_amount_cents: free ? 0 : carrierComponent + handling,
    carrier_cost_cents: carrierCost, carrier_service_name: live ? carrier.service : null,
    pick_pack_fee_cents: fee.pick_pack_fee_cents, packaging_cents: fee.packaging_cents,
    pick_pack_passed_through: inputs.pass_through, free_shipping_applied: free,
    delivery_window_start: live ? carrier.start : null, delivery_window_end: live ? carrier.end : null,
    thinnr_shipping_cost_cents: carrierCost + fee.pick_pack_fee_cents + fee.packaging_cents,
  };
}

/** Both methods on the flat HQ charge (address unknown, weights missing, or rating failed). */
export function flatShipmentOptions(inputs: QuoteInputs, reason: FallbackReason): ShipmentOptions {
  return {
    standard: assemble(inputs, "standard", null, reason),
    expedited: inputs.settings.expedited_enabled ? assemble(inputs, "expedited", null, reason) : null,
  };
}

// Short-lived cache so the checkout address debounce and the quote→checkout pair share one carrier call.
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;
const rateCache = new Map<string, { expires: number; result: RateQuoteResult }>();
export function clearRateCache(): void { rateCache.clear(); }

function cacheKey(lines: RateLine[], address: ShippingAddress): string {
  const sorted = lines.map((line) => `${line.sku ?? ""}|${line.weight_oz}|${line.quantity}`).sort();
  return JSON.stringify({ lines: sorted, zip: address.postal_code.trim().slice(0, 5), country: address.country || "US" });
}

async function cachedRates(lines: RateLine[], address: ShippingAddress, fetcher: RateFetcher, now: number): Promise<RateQuoteResult> {
  const key = cacheKey(lines, address);
  const hit = rateCache.get(key);
  if (hit && hit.expires > now) return hit.result;
  const result = await fetcher(buildRateRequest(lines, address));
  if (rateCache.size >= CACHE_MAX) rateCache.delete(rateCache.keys().next().value as string);
  rateCache.set(key, { expires: now + CACHE_TTL_MS, result });
  return result;
}

export interface RateShipmentInput extends QuoteInputs {
  address: ShippingAddress | null;
  fetcher?: RateFetcher;
  now?: number;
}

/**
 * Quote one shipment for every offered method. Transient carrier problems and
 * shape gaps fall back to the flat charge (never block checkout); a definite
 * bad address throws ShippingAddressError (422) so the patient can fix it.
 */
export async function rateShipment(input: RateShipmentInput): Promise<ShipmentOptions> {
  const { address } = input;
  if (!address || !address.postal_code?.trim()) return flatShipmentOptions(input, "no_address");
  if (input.lines.length === 0 || input.lines.some((line) => line.weight_oz === null || line.weight_oz <= 0)) {
    return flatShipmentOptions(input, "missing_weight");
  }
  const rateLines: RateLine[] = input.lines.map((line) => ({
    sku: line.sku, name: line.name, quantity: line.quantity, weight_oz: line.weight_oz as number, unit_price_cents: line.unit_price_cents,
  }));
  let result: RateQuoteResult;
  try {
    result = await cachedRates(rateLines, address, input.fetcher ?? fetchShippingRates, input.now ?? Date.now());
  } catch (error) {
    if (error instanceof WarehouseCraftError && error.kind === "bad_address") {
      throw new ShippingAddressError("We couldn't find shipping rates for that address. Check the ZIP code and try again.");
    }
    return flatShipmentOptions(input, "rating_unavailable");
  }
  const quoteFor = (method: ShippingMethod): ShipmentQuote => {
    const rate = pickRate(result, method);
    if (!rate) return assemble(input, method, null, "no_rate_for_method");
    return assemble(input, method, { cost: rate.total_price_cents, service: rate.service_name, start: rate.min_delivery_date, end: rate.max_delivery_date }, null);
  };
  return { standard: quoteFor("standard"), expedited: input.settings.expedited_enabled ? quoteFor("expedited") : null };
}

export function selectMethod(options: ShipmentOptions, method: ShippingMethod): ShipmentQuote {
  if (method === "expedited" && options.expedited) return options.expedited;
  return options.standard;
}

export function isShippingMethod(value: unknown): value is ShippingMethod {
  return value === "standard" || value === "expedited";
}
