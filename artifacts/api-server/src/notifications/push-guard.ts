/**
 * Last line of defence before a push leaves for Expo's servers.
 *
 * Push notifications travel through a vendor without a BAA, so a message may
 * carry only generic copy and a handful of ids the app needs to open the right
 * screen. Builders are written to that rule and tested for it; this guard
 * enforces it structurally at the send seam so a future builder cannot
 * regress it: over-long copy, nested payloads, forbidden field names, and
 * long free-text values are all refused and the message never leaves.
 *
 * A refused message is reported as a non-transient ticket error (never a
 * transport failure) so the sender records the attempt and fails the row
 * without retrying it.
 */
import type { ExpoPushClient, PushMessage, PushTicket } from "./expo-push";

export const PUSH_TITLE_MAX_CHARS = 60;
export const PUSH_BODY_MAX_CHARS = 140;
/** Longest string any data field may carry; ids, routes, and dates all fit easily. */
export const PUSH_DATA_VALUE_MAX_CHARS = 120;
export const PUSH_GUARD_ERROR_CODE = "MessageBlockedByGuard";

/**
 * Data keys whose camelCase tokens name a person, a contact detail, clinical
 * content, or free text. Keys ending in `Id`, `Ids`, or `Key` are identifiers
 * and are exempt (for example `messageClientId`, `medicationId`).
 */
const FORBIDDEN_DATA_TOKENS = new Set([
  "name", "first", "last", "full", "email", "phone", "address", "dob", "birth", "birthday",
  "medication", "medications", "med", "meds", "dose", "doses", "dosage", "weight", "weights", "bmi",
  "lab", "labs", "bloodwork", "diagnosis", "condition", "photo", "photos", "measurement", "measurements",
  "reason", "reasons", "patients", "message", "messages", "text", "body", "title", "note", "notes",
  "summary", "finding", "findings", "office", "recipient", "product", "products", "carrier", "tracking",
]);

export type PushGuardVerdict = { ok: true } | { ok: false; reason: string };

function tokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isForbiddenPushDataKey(key: string): boolean {
  if (/(Id|Ids|Key)$/.test(key) || key === "id") return false;
  return tokens(key).some((token) => FORBIDDEN_DATA_TOKENS.has(token));
}

/** Pure check for one message. Exposed so builder suites can assert their payloads pass. */
export function guardPushMessage(message: PushMessage): PushGuardVerdict {
  if (typeof message.title !== "string" || !message.title.trim()) return { ok: false, reason: "title missing" };
  if (message.title.length > PUSH_TITLE_MAX_CHARS) return { ok: false, reason: `title longer than ${PUSH_TITLE_MAX_CHARS} characters` };
  if (typeof message.body !== "string" || !message.body.trim()) return { ok: false, reason: "body missing" };
  if (message.body.length > PUSH_BODY_MAX_CHARS) return { ok: false, reason: `body longer than ${PUSH_BODY_MAX_CHARS} characters` };
  if (message.data === undefined) return { ok: true };
  if (!message.data || typeof message.data !== "object" || Array.isArray(message.data)) return { ok: false, reason: "data must be an object" };
  for (const [key, value] of Object.entries(message.data)) {
    if (isForbiddenPushDataKey(key)) return { ok: false, reason: `data field "${key}" is not allowed in a push` };
    if (value === null || value === undefined) continue;
    if (typeof value === "object") return { ok: false, reason: `data field "${key}" must be a scalar` };
    if (typeof value === "string" && value.length > PUSH_DATA_VALUE_MAX_CHARS) {
      return { ok: false, reason: `data field "${key}" longer than ${PUSH_DATA_VALUE_MAX_CHARS} characters` };
    }
  }
  return { ok: true };
}

export function guardTicket(reason: string): PushTicket {
  return { status: "error", message: `blocked before send: ${reason}`, details: { error: PUSH_GUARD_ERROR_CODE } };
}

/**
 * Sends only the messages that pass the guard and returns one ticket per
 * input message in order, with a guard ticket in place of each refused one.
 * Transport errors propagate exactly as `client.send` raises them.
 */
export async function sendGuarded(client: ExpoPushClient, messages: PushMessage[]): Promise<PushTicket[]> {
  const verdicts = messages.map(guardPushMessage);
  const allowed = messages.filter((_, index) => verdicts[index]!.ok);
  const sent = allowed.length ? await client.send(allowed) : [];
  let cursor = 0;
  return verdicts.map((verdict) => {
    if (verdict.ok) return sent[cursor++] ?? guardTicket("transport returned no ticket");
    return guardTicket(verdict.reason);
  });
}
