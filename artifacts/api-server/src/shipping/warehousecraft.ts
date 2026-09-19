/**
 * WarehouseCraft (NovEx's WMS) HTTP client — shipping rates.
 *
 * Facts pinned by real calls on 2026-09-18 (fixture: fixtures/warehousecraft-rates-nashville.json):
 * - Rates live at `POST {rates base}/api/general/ShippingRates` on WarehouseCraft's shared API
 *   host (default https://api.warehousecraft.com), NOT on the NovEx order-API host. The endpoint
 *   returns "general" ISC rates and answered identically with and without Basic auth; we still
 *   send the account's Basic credentials when configured (the `api/client/...` variants require them).
 * - The request needs `Rate.origin`, `Rate.destination` and `Rate.items[]` (items carry the weight:
 *   `lbs` × `quantity`; `packages[]` and their dimensions did not change any rate). A missing origin
 *   makes the server throw ("Object reference not set...", HTTP 400), so one is always sent even
 *   though the docs say the ISC warehouse origin overwrites it.
 * - ORIGIN ASSUMPTION: the account's shipping warehouse is assumed to be NovEx Memphis, TN. The 3PL
 *   has not confirmed (their answer: "MEM vs SLC — ask Kelsey"); the endpoint ignores the origin we
 *   send, so the assumption only affects the placeholder below and the delivery-window copy.
 * - Response: `{ rates: [{ service_code, service_name, total_price (cents), total_price_usd,
 *   min_delivery_date, max_delivery_date (local date, no tz) ... }], carrierErrors: [...] }`.
 *   Standard = service_name "USPS Ground Advantage" (ISC_77); expedited = "USPS Priority Mail" (ISC_2).
 * - Bad/missing postal code, missing destination or items → HTTP 400 with an EMPTY body.
 *
 * Credentials: WAREHOUSECRAFT_API_BASE_URL / _USERNAME / _PASSWORD, falling back to the pre-existing
 * NOVEX_API_* secrets (their host is the NovEx tenant of warehousecraft.com, so they are the same
 * account). A bare host is accepted and treated as https.
 */
import type { ShippingAddress } from "../billing/types";

export type ShippingMethod = "standard" | "expedited";

export const METHOD_SERVICE_NAMES: Record<ShippingMethod, string> = {
  standard: "USPS Ground Advantage",
  expedited: "USPS Priority Mail",
};

/** Placeholder origin sent with every request (see ORIGIN ASSUMPTION above). */
export const ASSUMED_ORIGIN = {
  country: "US", postal_code: "38118", province: "TN", city: "Memphis", name: "NovEx",
  address1: "NovEx Fulfillment", address_type: "commercial", company_name: "NovEx",
} as const;

export interface RateLine {
  sku: string | null;
  name: string;
  quantity: number;
  /** Shipping weight per unit in ounces. */
  weight_oz: number;
  unit_price_cents: number;
}

export interface RateRequest {
  Rate: {
    origin: typeof ASSUMED_ORIGIN;
    destination: Record<string, string>;
    items: Array<{ name: string; sku: string; quantity: number; lbs: number; price_usd: number; requires_shipping: true }>;
    currency: "USD";
  };
}

export interface CarrierRate {
  service_code: string;
  service_name: string;
  /** Whole cents. */
  total_price_cents: number;
  /** ISO calendar dates (YYYY-MM-DD) as returned, local to the carrier; null when the API sent none. */
  min_delivery_date: string | null;
  max_delivery_date: string | null;
}

export interface RateQuoteResult {
  rates: CarrierRate[];
  carrier_errors: string[];
}

export class WarehouseCraftError extends Error {
  constructor(message: string, readonly kind: "bad_address" | "transient", readonly status: number | null) {
    super(message);
  }
}

const OUNCES_PER_POUND = 16;

function env(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function normalizeBase(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

export type WarehouseTenantMode = "test" | "live";

/**
 * Which warehouse tenant the configured credentials belong to. Defaults to "test":
 * real (Stripe live-mode) orders are HELD until an operator sets
 * WAREHOUSECRAFT_TENANT_MODE=live alongside the live credentials, and Stripe
 * sandbox orders are never sent to a live tenant. Rates and the status poll are
 * read-only and run in either mode.
 */
export function warehouseTenantMode(): WarehouseTenantMode {
  const raw = (env("WAREHOUSECRAFT_TENANT_MODE") ?? "test").toLowerCase();
  return raw === "live" || raw === "production" || raw === "prod" ? "live" : "test";
}

export function warehouseCraftConfig() {
  const username = env("WAREHOUSECRAFT_API_USERNAME") ?? env("NOVEX_API_USERNAME");
  const password = env("WAREHOUSECRAFT_API_PASSWORD") ?? env("NOVEX_API_PASSWORD");
  const orderApi = env("WAREHOUSECRAFT_API_BASE_URL") ?? env("NOVEX_API_BASE_URL");
  return {
    ratesBaseUrl: normalizeBase(env("WAREHOUSECRAFT_RATES_BASE_URL") ?? "https://api.warehousecraft.com"),
    orderApiBaseUrl: orderApi ? normalizeBase(orderApi) : null,
    authorization: username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : null,
    timeoutMs: Math.max(1000, Number(env("WAREHOUSECRAFT_TIMEOUT_MS") ?? "8000") || 8000),
  };
}

export function buildRateRequest(lines: RateLine[], address: ShippingAddress): RateRequest {
  if (lines.length === 0) throw new Error("A rate request needs at least one line.");
  return {
    Rate: {
      origin: ASSUMED_ORIGIN,
      destination: {
        country: address.country || "US", postal_code: address.postal_code.trim(), province: address.state.trim().toUpperCase(),
        city: address.city.trim(), name: address.name, address1: address.line1, address2: address.line2 ?? "",
        phone: address.phone ?? "", address_type: "residential",
      },
      items: lines.map((line) => ({
        name: line.name, sku: line.sku ?? "", quantity: line.quantity,
        lbs: Math.round((line.weight_oz / OUNCES_PER_POUND) * 1000) / 1000, price_usd: line.unit_price_cents / 100, requires_shipping: true,
      })),
      currency: "USD",
    },
  };
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!match || match[1].startsWith("0001")) return null;
  return match[1];
}

/** Typed from the recorded response; tolerant of extra fields, strict about the ones we use. */
export function parseRateResponse(body: unknown): RateQuoteResult {
  if (!body || typeof body !== "object") throw new WarehouseCraftError("Rate response was not an object.", "transient", null);
  const raw = body as { rates?: unknown; carrierErrors?: unknown };
  const rates: CarrierRate[] = [];
  for (const entry of Array.isArray(raw.rates) ? raw.rates : []) {
    if (!entry || typeof entry !== "object") continue;
    const rate = entry as Record<string, unknown>;
    const cents = typeof rate.total_price === "number" && Number.isFinite(rate.total_price)
      ? Math.round(rate.total_price)
      : typeof rate.total_price_usd === "number" && Number.isFinite(rate.total_price_usd) ? Math.round(rate.total_price_usd * 100) : null;
    if (cents === null || cents < 0 || typeof rate.service_name !== "string") continue;
    rates.push({
      service_code: typeof rate.service_code === "string" ? rate.service_code : "",
      service_name: rate.service_name,
      total_price_cents: cents,
      min_delivery_date: dateOnly(rate.min_delivery_date),
      max_delivery_date: dateOnly(rate.max_delivery_date),
    });
  }
  const carrier_errors = (Array.isArray(raw.carrierErrors) ? raw.carrierErrors : [])
    .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).Error ?? "") : ""))
    .filter(Boolean);
  return { rates, carrier_errors };
}

/** The cheapest rate whose service name matches the method's carrier service (repeat rows exist for some services). */
export function pickRate(result: RateQuoteResult, method: ShippingMethod): CarrierRate | null {
  const wanted = METHOD_SERVICE_NAMES[method].toLowerCase();
  const matches = result.rates.filter((rate) => rate.service_name.trim().toLowerCase() === wanted);
  if (matches.length === 0) return null;
  return matches.reduce((best, rate) => (rate.total_price_cents < best.total_price_cents ? rate : best));
}

/**
 * HTTP 400 with an empty body is how the API rejects an address it cannot rate
 * (bad ZIP, missing city); the same status with a server exception text is a
 * request-shape problem on our side and must fall back rather than block a patient.
 */
export function classifyHttpFailure(status: number, bodyText: string): WarehouseCraftError["kind"] {
  if (status === 400 && !/object reference|exception|error requesting/i.test(bodyText)) return "bad_address";
  return "transient";
}

export type RateFetcher = (request: RateRequest) => Promise<RateQuoteResult>;

/** One bounded call to the rates endpoint; throws WarehouseCraftError with a classified kind. */
export const fetchShippingRates: RateFetcher = async (request) => {
  const config = warehouseCraftConfig();
  let response: Response;
  try {
    response = await fetch(`${config.ratesBaseUrl}/api/general/ShippingRates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json",
        ...(config.authorization ? { Authorization: config.authorization } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new WarehouseCraftError(`WarehouseCraft unreachable: ${error instanceof Error ? error.message : String(error)}`, "transient", null);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new WarehouseCraftError(`WarehouseCraft rates HTTP ${response.status}`, classifyHttpFailure(response.status, text), response.status);
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    throw new WarehouseCraftError("WarehouseCraft returned a non-JSON rate response.", "transient", response.status);
  }
  return parseRateResponse(json);
};
