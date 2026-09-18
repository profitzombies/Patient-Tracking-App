import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/warehousecraft-rates-nashville.json";
import {
  buildRateRequest, classifyHttpFailure, fetchShippingRates, parseRateResponse, pickRate, WarehouseCraftError,
} from "./warehousecraft";
import {
  clearRateCache, computePickPackFee, DEFAULT_PICK_PACK_SCHEDULE, flatShipmentOptions, normalizeSchedule, rateShipment,
  resolvePassThrough, ShippingAddressError, suggestedTier, type FulfillmentLine, type ShippingRuleSettings,
} from "./rating";

const address = { name: "Test Patient", line1: "1 Music Square W", line2: null, city: "Nashville", state: "tn", postal_code: "37203", country: "US", phone: null };
const settings: ShippingRuleSettings = {
  shipping_charge_cents: 1000, shipping_cost_cents: 900, free_shipping_over_cents: null, pick_pack_tier: "under_50",
  pick_pack_schedule: DEFAULT_PICK_PACK_SCHEDULE, pick_pack_pass_through_default: true, expedited_enabled: true,
};
const line = (over: Partial<FulfillmentLine> = {}): FulfillmentLine => ({
  product_id: "p1", name: "SlimCell", sku: "Test01", quantity: 3, weight_oz: 8, oversized: false, unit_price_cents: 4900, ...over,
});

afterEach(() => { clearRateCache(); vi.restoreAllMocks(); });

describe("warehousecraft client", () => {
  it("builds the request the API accepted: origin placeholder, destination, items carrying lbs", () => {
    const request = buildRateRequest([{ sku: "Test01", name: "SlimCell", quantity: 2, weight_oz: 24, unit_price_cents: 4900 }], address);
    expect(request.Rate.origin.city).toBe("Memphis");
    expect(request.Rate.destination).toMatchObject({ country: "US", postal_code: "37203", province: "TN", city: "Nashville" });
    expect(request.Rate.items).toEqual([{ name: "SlimCell", sku: "Test01", quantity: 2, lbs: 1.5, price_usd: 49, requires_shipping: true }]);
    expect(() => buildRateRequest([], address)).toThrow();
  });

  it("parses the recorded response and picks the cheapest matching service per method", () => {
    const parsed = parseRateResponse(fixture);
    expect(parsed.rates.length).toBe(21);
    expect(parsed.carrier_errors.length).toBeGreaterThan(0);
    expect(pickRate(parsed, "standard")).toEqual({
      service_code: "ISC_77", service_name: "USPS Ground Advantage", total_price_cents: 807, min_delivery_date: "2026-09-22", max_delivery_date: "2026-09-22",
    });
    expect(pickRate(parsed, "expedited")).toMatchObject({ service_code: "ISC_2", total_price_cents: 1671, min_delivery_date: "2026-09-21" });
  });

  it("tolerates missing dates and cents, and ignores malformed rows", () => {
    const parsed = parseRateResponse({ rates: [
      { service_name: "USPS Ground Advantage", total_price_usd: 8.07, min_delivery_date: "0001-01-01T00:00:00" },
      { service_name: "USPS Ground Advantage", total_price: 700 }, { service_name: 5, total_price: 1 }, null,
    ] });
    expect(parsed.rates).toHaveLength(2);
    expect(parsed.rates[0]).toMatchObject({ total_price_cents: 807, min_delivery_date: null });
    expect(pickRate(parsed, "standard")?.total_price_cents).toBe(700);
    expect(pickRate(parsed, "expedited")).toBeNull();
    expect(() => parseRateResponse("nope")).toThrow(WarehouseCraftError);
  });

  it("classifies failures: empty-body 400 = bad address, server exception 400 / 5xx = transient", () => {
    expect(classifyHttpFailure(400, "")).toBe("bad_address");
    expect(classifyHttpFailure(400, "\"Error requesting rates: Object reference not set to an instance of an object.\"")).toBe("transient");
    expect(classifyHttpFailure(500, "")).toBe("transient");
    expect(classifyHttpFailure(429, "")).toBe("transient");
  });

  it("fetches with a bounded timeout and maps network errors to transient", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(fetchShippingRates(buildRateRequest([{ ...line(), weight_oz: 8 }], address))).rejects.toMatchObject({ kind: "transient" });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockResolvedValue(new Response("", { status: 400 }));
    await expect(fetchShippingRates(buildRateRequest([{ ...line(), weight_oz: 8 }], address))).rejects.toMatchObject({ kind: "bad_address", status: 400 });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    expect((await fetchShippingRates(buildRateRequest([{ ...line(), weight_oz: 8 }], address))).rates).toHaveLength(21);
  });
});

describe("pick-and-pack fee", () => {
  it("3 units, base tier, nothing oversized = $4.95 + 3 × $0.25", () => {
    const fee = computePickPackFee([line()], DEFAULT_PICK_PACK_SCHEDULE, "under_50");
    expect(fee).toMatchObject({ order_fee_cents: 495, unit_fee_cents: 75, overweight_fee_cents: 0, pick_pack_fee_cents: 570, packaging_cents: 0, units: 3 });
  });

  it("pins every tier from the proposal", () => {
    const one = [line({ quantity: 1 })];
    const expected = { under_50: 520, from_51: 450, from_100: 420, from_250: 370, from_500: 320, from_1500: 200 } as const;
    for (const [tier, total] of Object.entries(expected)) {
      expect(computePickPackFee(one, DEFAULT_PICK_PACK_SCHEDULE, tier as keyof typeof expected).pick_pack_fee_cents).toBe(total);
    }
  });

  it("charges oversized units $0.75 instead of $0.25 and +$2.00 per unit over 30 lb", () => {
    const fee = computePickPackFee([line({ quantity: 2, oversized: true }), line({ product_id: "p2", quantity: 1, weight_oz: 31 * 16 })], DEFAULT_PICK_PACK_SCHEDULE, "from_100");
    expect(fee).toMatchObject({ order_fee_cents: 395, unit_fee_cents: 150 + 25, overweight_fee_cents: 200, pick_pack_fee_cents: 770, oversized_units: 2, overweight_units: 1 });
    // exactly 30 lb is not over the threshold
    expect(computePickPackFee([line({ quantity: 1, weight_oz: 480 })], DEFAULT_PICK_PACK_SCHEDULE, "under_50").overweight_units).toBe(0);
  });

  it("includes the packaging allowance and honours an edited schedule", () => {
    const schedule = normalizeSchedule({ ...DEFAULT_PICK_PACK_SCHEDULE, packaging_cents: 60, unit_cents: 30, order_fee_cents: { under_50: 400 } });
    expect(schedule.order_fee_cents.from_51).toBe(425);
    const fee = computePickPackFee([line()], schedule, "under_50");
    expect(fee.pick_pack_fee_cents).toBe(400 + 90);
    expect(fee.packaging_cents).toBe(60);
    expect(normalizeSchedule(null)).toEqual(DEFAULT_PICK_PACK_SCHEDULE);
    expect(normalizeSchedule({ unit_cents: -5, overweight_threshold_lb: 0 })).toEqual(DEFAULT_PICK_PACK_SCHEDULE);
  });

  it("maps weekly volume to the proposal bands and resolves office pass-through with null-inherit", () => {
    expect([0, 50, 51, 99, 100, 249, 250, 499, 500, 1499, 1500].map(suggestedTier)).toEqual([
      "under_50", "under_50", "from_51", "from_51", "from_100", "from_100", "from_250", "from_250", "from_500", "from_500", "from_1500",
    ]);
    expect(resolvePassThrough(settings, null)).toBe(true);
    expect(resolvePassThrough(settings, false)).toBe(false);
    expect(resolvePassThrough({ pick_pack_pass_through_default: false }, undefined)).toBe(false);
  });
});

describe("rateShipment", () => {
  const fetcher = vi.fn(async () => parseRateResponse(fixture));

  it("quotes both methods live from one carrier call and adds the passed-through fee", async () => {
    fetcher.mockClear();
    const options = await rateShipment({ lines: [line()], subtotal_cents: 14700, settings, pass_through: true, address, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(options.standard).toMatchObject({
      source: "live", patient_amount_cents: 807 + 570, carrier_cost_cents: 807, carrier_service_name: "USPS Ground Advantage",
      pick_pack_fee_cents: 570, pick_pack_passed_through: true, delivery_window_start: "2026-09-22", delivery_window_end: "2026-09-22",
      thinnr_shipping_cost_cents: 807 + 570, free_shipping_applied: false,
    });
    expect(options.expedited).toMatchObject({ source: "live", patient_amount_cents: 1671 + 570, carrier_cost_cents: 1671, delivery_window_start: "2026-09-21" });
    // identical (lines, ZIP) reuse the cached carrier response
    await rateShipment({ lines: [line()], subtotal_cents: 100, settings, pass_through: false, address: { ...address, line1: "elsewhere" }, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("office absorbs the fee when pass-through is off; THINNR's recovery is unchanged", async () => {
    const options = await rateShipment({ lines: [line()], subtotal_cents: 14700, settings, pass_through: false, address, fetcher });
    expect(options.standard).toMatchObject({ patient_amount_cents: 807, pick_pack_passed_through: false, thinnr_shipping_cost_cents: 807 + 570 });
  });

  it("free standard above the HQ threshold, expedited still full price, expedited hidden when disabled", async () => {
    const free = { ...settings, free_shipping_over_cents: 10000 };
    const options = await rateShipment({ lines: [line()], subtotal_cents: 14700, settings: free, pass_through: true, address, fetcher });
    expect(options.standard).toMatchObject({ patient_amount_cents: 0, free_shipping_applied: true, thinnr_shipping_cost_cents: 807 + 570 });
    expect(options.expedited?.patient_amount_cents).toBe(1671 + 570);
    const below = await rateShipment({ lines: [line()], subtotal_cents: 9999, settings: free, pass_through: true, address, fetcher });
    expect(below.standard.patient_amount_cents).toBe(807 + 570);
    const noExpedited = await rateShipment({ lines: [line()], subtotal_cents: 1, settings: { ...settings, expedited_enabled: false }, pass_through: true, address, fetcher });
    expect(noExpedited.expedited).toBeNull();
  });

  it("falls back to the flat charge exactly on timeout / 5xx / empty rates (fee still recovered), records the reason", async () => {
    const failing = vi.fn(async () => { throw new WarehouseCraftError("timeout", "transient", null); });
    const options = await rateShipment({ lines: [line()], subtotal_cents: 100, settings, pass_through: true, address, fetcher: failing });
    expect(options.standard).toMatchObject({
      source: "fallback", fallback_reason: "rating_unavailable", patient_amount_cents: 1000, carrier_cost_cents: 900,
      pick_pack_fee_cents: 570, delivery_window_start: null, carrier_service_name: null, thinnr_shipping_cost_cents: 900 + 570,
    });
    const empty = vi.fn(async () => ({ rates: [], carrier_errors: ["GLS Failure"] }));
    const none = await rateShipment({ lines: [line()], subtotal_cents: 100, settings, pass_through: false, address: { ...address, postal_code: "90210" }, fetcher: empty });
    expect(none.standard).toMatchObject({ source: "fallback", fallback_reason: "no_rate_for_method", patient_amount_cents: 1000 });
  });

  it("never calls the carrier without an address or a weight, and surfaces a bad address as 422", async () => {
    const spy = vi.fn(async () => parseRateResponse(fixture));
    expect((await rateShipment({ lines: [line()], subtotal_cents: 100, settings, pass_through: true, address: null, fetcher: spy })).standard.fallback_reason).toBe("no_address");
    expect((await rateShipment({ lines: [line({ weight_oz: null })], subtotal_cents: 100, settings, pass_through: true, address, fetcher: spy })).standard.fallback_reason).toBe("missing_weight");
    expect(spy).not.toHaveBeenCalled();
    const bad = vi.fn(async () => { throw new WarehouseCraftError("400", "bad_address", 400); });
    await expect(rateShipment({ lines: [line()], subtotal_cents: 100, settings, pass_through: true, address: { ...address, postal_code: "00000" }, fetcher: bad }))
      .rejects.toBeInstanceOf(ShippingAddressError);
    expect(flatShipmentOptions({ lines: [line()], subtotal_cents: 0, settings, pass_through: true }, "no_address").expedited?.patient_amount_cents).toBe(1000);
  });
});
