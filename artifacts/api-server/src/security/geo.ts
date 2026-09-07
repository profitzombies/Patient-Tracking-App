/**
 * Approximate region for a sign-in IP — "City, Region, Country" at best,
 * "Private network" for loopback/RFC1918 addresses, null when nothing is
 * known. Two sources, cheapest first:
 *
 *   1. Geo headers an edge proxy already stamped (Cloudflare, Vercel,
 *      App Engine style) — free and synchronous.
 *   2. A lookup service (default ipwho.is, override with AUTH_GEOIP_URL
 *      using `{ip}`; AUTH_GEOIP_LOOKUP=off disables it). Called AFTER the
 *      sign-in response so it never slows a login, cached per IP in memory.
 *
 * Only the region string is stored; the IP itself is not written to the
 * ledger.
 */

type Headers = Record<string, unknown>;

function header(headers: Headers, name: string): string | null {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function joinRegion(parts: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const clean = (part ?? "").trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out.length ? out.join(", ").slice(0, 120) : null;
}

export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === "::1" || ip.startsWith("127.") || ip === "0.0.0.0") return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  if (ip.startsWith("::ffff:")) return isPrivateIp(ip.slice(7));
  return false;
}

/** Region from proxy geo headers, when the edge already resolved it. */
export function regionFromHeaders(headers: Headers): string | null {
  const decode = (value: string | null) => {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const city = decode(header(headers, "cf-ipcity") ?? header(headers, "x-vercel-ip-city") ?? header(headers, "x-appengine-city"));
  const region = decode(header(headers, "cf-region") ?? header(headers, "x-vercel-ip-country-region") ?? header(headers, "x-appengine-region"));
  const country = header(headers, "cf-ipcountry") ?? header(headers, "x-vercel-ip-country") ?? header(headers, "x-appengine-country");
  const cleanCountry = country && country !== "XX" && country !== "T1" ? country.toUpperCase() : null;
  return joinRegion([city, region, cleanCountry]);
}

const cache = new Map<string, { region: string | null; at: number }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 2000;

function lookupEnabled(): boolean {
  const knob = (process.env.AUTH_GEOIP_LOOKUP ?? "").trim().toLowerCase();
  return knob !== "off" && knob !== "0" && knob !== "false";
}

function lookupUrl(ip: string): string {
  const template = (process.env.AUTH_GEOIP_URL ?? "").trim() || "https://ipwho.is/{ip}";
  return template.replace("{ip}", encodeURIComponent(ip));
}

function pick(json: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = json[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Best-effort remote lookup; never throws, null when unknown or disabled. */
export async function lookupRegion(ip: string | null, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!ip) return null;
  if (isPrivateIp(ip)) return "Private network";
  if (!lookupEnabled()) return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.region;
  let region: string | null = null;
  try {
    const response = await fetchImpl(lookupUrl(ip), { signal: AbortSignal.timeout(2500) });
    if (response.ok) {
      const json = (await response.json()) as Record<string, unknown>;
      const failed = json.success === false || json.status === "fail" || typeof json.error === "string";
      if (!failed) {
        region = joinRegion([
          pick(json, ["city"]),
          pick(json, ["region", "regionName", "region_name", "region_code"]),
          pick(json, ["country", "country_name", "countryCode", "country_code"]),
        ]);
      }
    }
  } catch {
    region = null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ip, { region, at: Date.now() });
  return region;
}

/** Test hook. */
export function resetGeoCache(): void {
  cache.clear();
}
