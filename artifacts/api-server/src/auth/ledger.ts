/**
 * Shared one-time-code verification ledger helpers.
 *
 * The claim flow and the passwordless login/signup flows all ride the same
 * `claim_verifications` table and the same `claim_register_send` atomic
 * send-cap RPC. These helpers are the single copy of the row-shape, hashing,
 * attempt-counting, and timing-floor mechanics both routers share, so the
 * security behaviors (timing-safe compares, optimistic attempt guards,
 * response-timing floors) cannot drift between flows.
 */
import crypto from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";

export type AccountType = "patient" | "provider" | "team_member" | "hq_admin";

export interface Candidate {
  type: AccountType;
  ref: string;
  name: string | null;
  dob: string | null;
  claimed: boolean;
  auth_user_id: string | null;
}

export interface VerificationRow {
  id: string;
  created_at: string;
  purpose: "claim" | "add_phone" | "login" | "signup" | "recovery" | "profile_email" | "profile_phone" | "password_change" | "cart_pay" | "staff_sms" | "account_deletion";
  identifier_kind: "phone" | "email";
  identifier: string;
  account_type: AccountType | null;
  candidates: Candidate[];
  resolved_ref: string | null;
  delivery: "dev" | "twilio_verify" | "resend";
  code_salt: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  code_attempts: number;
  verified_at: string | null;
  claim_token_hash: string | null;
  birthday_checked: boolean;
  consumed_at: string | null;
  auth_user_id: string | null;
  scope_key: string | null;
}

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const SENDS_PER_IDENTIFIER_PER_HOUR = 3;

/**
 * Identify-style endpoints must take the same time whether or not an account
 * exists — otherwise response timing becomes an existence oracle even though
 * the response bodies are identical. Every account-dependent outcome (miss,
 * send-capped, hit) is held to this minimum elapsed time. The real work is
 * one database round trip, which fits well inside the floor. Callers that
 * await a live provider must add a provider-sized neutral floor of their own.
 */
const IDENTIFY_FLOOR_DEFAULT_MS = 350;

function identifyFloorMs(): number {
  const raw = Number(process.env.CLAIM_IDENTIFY_FLOOR_MS ?? IDENTIFY_FLOOR_DEFAULT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : IDENTIFY_FLOOR_DEFAULT_MS;
}

export async function holdUntilFloor(startedAt: number): Promise<void> {
  const wait = identifyFloorMs() - (Date.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function codeMatches(row: VerificationRow, code: string): boolean {
  if (!row.code_salt || !row.code_hash) return false;
  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(sha256(row.code_salt + code), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export async function loadRowById(id: string): Promise<VerificationRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/claim_verifications?id=eq.${enc(id)}&select=*`,
  );
  if (res.status >= 300) throw new Error(`claim row load failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length > 0 ? (res.json[0] as VerificationRow) : null;
}

export async function loadRowByToken(token: string): Promise<VerificationRow | null> {
  const hash = sha256(token);
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/claim_verifications?claim_token_hash=eq.${enc(hash)}&select=*`,
  );
  if (res.status >= 300) throw new Error(`claim row load failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length > 0 ? (res.json[0] as VerificationRow) : null;
}

export async function patchRow(
  id: string,
  patch: Record<string, unknown>,
  guard = "",
): Promise<number> {
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/claim_verifications?id=eq.${enc(id)}${guard}`,
    patch,
    "return=representation",
  );
  if (res.status >= 300) throw new Error(`claim row update failed (${res.status})`);
  return Array.isArray(res.json) ? res.json.length : 0;
}

/**
 * Count-a-code-attempt with an optimistic guard so parallel guesses cannot
 * share one attempt slot. Returns false when the row moved underneath us.
 */
export async function takeAttempt(row: VerificationRow): Promise<boolean> {
  const rows = await patchRow(
    row.id,
    { code_attempts: row.code_attempts + 1 },
    `&code_attempts=eq.${row.code_attempts}`,
  );
  return rows === 1;
}

/** Opportunistic ledger hygiene — expired rows are useless after a day. */
export function pruneStaleRows(): void {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  void supabaseAdmin(
    "DELETE",
    `/rest/v1/claim_verifications?created_at=lt.${enc(dayAgo)}`,
  ).catch(() => {});
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isTokenShaped(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isCodeShaped(value: unknown): value is string {
  return typeof value === "string" && /^\d{4,8}$/.test(value);
}

export function clientIp(req: { ip?: string }): string {
  return req.ip ?? "unknown";
}
