import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TapSaleResponse } from "@/lib/office-billing-types";
import type { TapFailure } from "@/lib/tap-to-pay-bridge";

/**
 * The one Tap to Pay sale this phone has staged but not yet seen settled.
 *
 * A staged sale holds card-present intents the patient may already have
 * tapped. Until the server has answered what became of them, this phone must
 * not start another sale, and that rule has to outlive the screen: the
 * provider may back out, the app may be killed mid-tap. So the cart key is
 * written here the moment the sale is staged and only removed once the
 * server's answer is definite (every tap captured, or `not_charged`). The
 * Sell to patient screen restores it on open and asks the server first.
 */
export interface UnsettledTapSale {
  cartId: string;
  patientId: string;
  patientName: string;
  sale: TapSaleResponse;
  /** The last failure the phone saw for this sale, if it got that far. */
  failure: TapFailure | null;
  stagedAt: string;
}

const KEY = "thinnr.office.tap-sale.unsettled";

export async function readUnsettledTapSale(): Promise<UnsettledTapSale | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UnsettledTapSale>;
    if (typeof parsed.cartId !== "string" || typeof parsed.patientId !== "string" || !parsed.sale) return null;
    return {
      cartId: parsed.cartId,
      patientId: parsed.patientId,
      patientName: typeof parsed.patientName === "string" ? parsed.patientName : "the patient",
      sale: parsed.sale,
      failure: parsed.failure ?? null,
      stagedAt: typeof parsed.stagedAt === "string" ? parsed.stagedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function rememberUnsettledTapSale(record: UnsettledTapSale): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(record));
}

/** Records the failure the phone saw, so a restored screen can explain itself; no-op for another cart. */
export async function noteUnsettledTapFailure(cartId: string, failure: TapFailure): Promise<void> {
  const current = await readUnsettledTapSale();
  if (!current || current.cartId !== cartId) return;
  await AsyncStorage.setItem(KEY, JSON.stringify({ ...current, failure }));
}

/** Only the sale that was settled may be forgotten: a newer record for another cart stays. */
export async function forgetUnsettledTapSale(cartId: string): Promise<void> {
  const current = await readUnsettledTapSale();
  if (current && current.cartId !== cartId) return;
  await AsyncStorage.removeItem(KEY);
}
