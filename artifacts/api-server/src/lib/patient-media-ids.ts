/**
 * Object ids for the per-patient media rail.
 *
 * A plain upload gets a random id. An upload that names a client
 * `uploadId` (the offline queue does — one id per queued photo) gets a
 * DETERMINISTIC id derived from (patient, kind, uploadId): re-minting the
 * upload URL after a lost response yields the very same object path, so
 * the retry overwrites the same object and re-finalizes the same ledger row
 * instead of allocating a second one that nothing references. The id keeps
 * the minted UUID shape so every existing path check and grid validation
 * applies unchanged.
 */
import { createHash, randomUUID } from "crypto";

export type PatientMediaKind = "food" | "recipe" | "chat" | "progress";

/** Same alphabet as an idempotency key; hashed, so length is the only cost. */
export const UPLOAD_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isValidUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID_RE.test(value);
}

/** UUID-shaped, version-8 style id derived from a SHA-256 of the inputs. */
function uuidFromHash(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "8"; // version nibble: 8 = custom/name-derived
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4]; // RFC 4122 variant
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function patientMediaObjectId(
  patientId: string,
  kind: PatientMediaKind,
  uploadId?: string | null,
): string {
  const uuid = uploadId ? uuidFromHash(`${patientId}\n${kind}\n${uploadId}`) : randomUUID();
  return `${kind}-${uuid}`;
}
