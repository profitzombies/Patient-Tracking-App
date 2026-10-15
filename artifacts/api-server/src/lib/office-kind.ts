/**
 * Office kind: what THINNR sold the practice.
 *
 *   * reseller — a THINNR reseller office (the default; every office created
 *                before kinds existed). Sees Marketing Assets (the HQ file
 *                drive) and Training, accepts the reseller access disclosure,
 *                and gets the organization's reseller included period.
 *   * software — a software-only practice. Same app, same setup wizard, but
 *                no Marketing Assets or Training, the software agreement in
 *                place of the disclosure, and the (shorter) software included
 *                period from the owner's first dashboard sign-in.
 *
 * Independent of `providers.plan` (Core/Plus/Concierge), which stays an HQ
 * classification that controls nothing. A missing or unknown value reads as
 * reseller so fixtures and legacy rows keep today's behaviour; the server is
 * the authority and clients only mirror what it returns.
 */
import { z } from "zod";
import { supabaseAdmin } from "./supabase-admin";

export const OFFICE_KINDS = ["reseller", "software"] as const;
export type OfficeKind = (typeof OFFICE_KINDS)[number];

export const OfficeKindInput = z.enum(OFFICE_KINDS);

export function officeKindOf(value: unknown): OfficeKind {
  return value === "software" ? "software" : "reseller";
}

/**
 * Surfaces a software-only office never gets, however the client asks.
 * Unknown reads as reseller, like everywhere else, so a scope built without
 * the kind (older fixtures) keeps today's behaviour.
 */
export function officeKindHasResellerContent(kind: OfficeKind | null | undefined): boolean {
  return officeKindOf(kind) === "reseller";
}

/** One office's kind, read fresh. Unknown office = reseller (nothing extra is granted by it). */
export async function loadOfficeKind(providerId: string): Promise<OfficeKind> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=provider_id,office_kind&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office kind lookup failed (${res.status})`);
  const row = res.json[0] as { office_kind?: unknown } | undefined;
  return officeKindOf(row?.office_kind);
}
