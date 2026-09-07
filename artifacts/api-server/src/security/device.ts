/**
 * Device facts for the sign-in ledger: platform, a short human label, and a
 * stable fingerprint — all derived from what the client sends, never from a
 * secret. The apps send an install id (`x-thinnr-device`) and platform
 * (`x-thinnr-platform`) header on the sign-in verify call; browsers and
 * older clients fall back to a user-agent family fingerprint, which is
 * coarse but still tells a person "a Windows Chrome browser signed in".
 */
import crypto from "node:crypto";

export type Platform = "ios" | "android" | "web" | "unknown";
export const PLATFORMS: readonly Platform[] = ["ios", "android", "web", "unknown"];

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,80}$/;
const UA_MAX = 300;

type Headers = Record<string, unknown>;

function header(headers: Headers, name: string): string | null {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function userAgentOf(headers: Headers): string | null {
  const ua = header(headers, "user-agent");
  return ua ? ua.slice(0, UA_MAX) : null;
}

export function platformOf(headers: Headers): Platform {
  const declared = header(headers, "x-thinnr-platform")?.toLowerCase();
  if (declared === "ios" || declared === "android" || declared === "web") return declared;
  const ua = userAgentOf(headers) ?? "";
  if (/iPhone|iPad|iPod|CFNetwork|Darwin/i.test(ua) && !/Macintosh/i.test(ua)) return "ios";
  if (/Android|okhttp/i.test(ua)) return "android";
  if (/Mozilla|Chrome|Safari|Firefox|Edg/i.test(ua)) return "web";
  return "unknown";
}

/** Client install id when it is well-formed, else null. */
export function deviceIdOf(headers: Headers): string | null {
  const id = header(headers, "x-thinnr-device");
  return id && DEVICE_ID_PATTERN.test(id) ? id : null;
}

/** Short user-agent family: browser + OS, or the native app. */
export function describeUserAgent(ua: string | null, platform: Platform): string {
  const agent = ua ?? "";
  const native = /Expo|okhttp|CFNetwork|Darwin\/|ReactNative/i.test(agent) && !/Mozilla/i.test(agent);
  if (platform === "ios" && (native || !agent)) return "THINNR app on iPhone";
  if (platform === "android" && (native || !agent)) return "THINNR app on Android";
  let browser = "Browser";
  if (/Edg\//i.test(agent)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(agent)) browser = "Opera";
  else if (/Firefox\//i.test(agent)) browser = "Firefox";
  else if (/Chrome\/|CriOS/i.test(agent)) browser = "Chrome";
  else if (/Safari\//i.test(agent)) browser = "Safari";
  let os = "";
  if (/iPhone|iPod/i.test(agent)) os = "iPhone";
  else if (/iPad/i.test(agent)) os = "iPad";
  else if (/Android/i.test(agent)) os = "Android";
  else if (/Windows/i.test(agent)) os = "Windows";
  else if (/Macintosh|Mac OS X/i.test(agent)) os = "Mac";
  else if (/CrOS/i.test(agent)) os = "ChromeOS";
  else if (/Linux/i.test(agent)) os = "Linux";
  if (!agent) return platform === "web" ? "Web browser" : "Unknown device";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Fingerprint: the install id when the client sent one (stable per app
 * install / browser profile), otherwise the user-agent family + platform,
 * so a first sign-in from a new browser family still registers as new.
 */
export function fingerprintOf(headers: Headers): { fingerprint: string; fromDeviceId: boolean } {
  const deviceId = deviceIdOf(headers);
  if (deviceId) {
    return { fingerprint: crypto.createHash("sha256").update(`device:${deviceId}`).digest("hex").slice(0, 40), fromDeviceId: true };
  }
  const platform = platformOf(headers);
  const family = describeUserAgent(userAgentOf(headers), platform);
  return {
    fingerprint: crypto.createHash("sha256").update(`ua:${platform}:${family}`).digest("hex").slice(0, 40),
    fromDeviceId: false,
  };
}

/** Opaque, short reference for a GoTrue session id — safe to show/compare, useless to replay. */
export function sessionRef(sessionId: string): string {
  return crypto.createHash("sha256").update(`session:${sessionId}`).digest("hex").slice(0, 16);
}

/** Strip the CIDR suffix PostgREST adds to inet columns. */
export function plainIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return ip.replace(/\/\d+$/, "");
}

/** Decode the session id claim of a GoTrue access token (no verification —
 * callers only use it after GoTrue has accepted the same token). */
export function sessionIdOfToken(token: string | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof payload.session_id === "string" && /^[0-9a-f-]{36}$/i.test(payload.session_id) ? payload.session_id : null;
  } catch {
    return null;
  }
}
