/**
 * THINNR's share of a patient payment, as it stands for one office right now.
 *
 * The normal share is the catalog's; an office restricted for nonpayment pays
 * the elevated share on every charge taken from that point forward, including
 * renewals of subscriptions that already exist. Charges that have already been
 * processed are never revisited: the share is read at charge time and
 * snapshotted on the order, so a restriction (or a recovery) only ever moves
 * the NEXT charge.
 */
import { NORMAL_THINNR_SHARE_PERCENT } from "./fees";
import { loadAccessBillingSettings, revenueSharePercent } from "./office-access/settings";
import { officeRestrictedForNonpayment } from "../lib/office-restriction";

export { NORMAL_THINNR_SHARE_PERCENT };

/**
 * The share percentage to charge this office's next patient payment at.
 *
 * A failure reading the policy or the office's access state falls back to the
 * normal share: over-charging an office that has paid is worse than missing an
 * elevated share on one charge.
 */
export async function officeThinnrSharePercent(providerId: string, now = new Date()): Promise<number> {
  try {
    const restricted = await officeRestrictedForNonpayment(providerId, now);
    if (!restricted) return NORMAL_THINNR_SHARE_PERCENT;
    return revenueSharePercent(await loadAccessBillingSettings(), true);
  } catch {
    return NORMAL_THINNR_SHARE_PERCENT;
  }
}

/**
 * Re-scale a share that was computed at the normal percentage (a snapshot from
 * an earlier charge) to today's percentage. Used where the exact floor prices
 * behind a share are no longer recoverable; identical at the normal share, so
 * the normal case is bit-for-bit unchanged.
 */
export function rescaleShare(shareAtNormalPercent: number, sharePercent: number): number {
  if (sharePercent === NORMAL_THINNR_SHARE_PERCENT) return shareAtNormalPercent;
  return Math.floor(shareAtNormalPercent * sharePercent / NORMAL_THINNR_SHARE_PERCENT);
}
