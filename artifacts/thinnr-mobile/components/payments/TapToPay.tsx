import { useEffect } from "react";
import {
  getTapToPayBridgeForTests,
  type TapFailure,
  type TapToPayClient,
} from "@/lib/tap-to-pay-bridge";

export interface TapToPayProps {
  /** Signed-in staff id: connection tokens are minted for their office. */
  userId: string;
  /** Hands the screen a client once the Terminal SDK is initialized. */
  onReady: (client: TapToPayClient) => void;
  /** The SDK cannot run here (device, entitlement, build); the screen falls back. */
  onUnavailable: (failure: TapFailure) => void;
}

/**
 * Node verification fallback. Metro selects TapToPay.native/web in real
 * builds; this implementation is the intentionally small test seam.
 */
export default function TapToPay({ onReady, onUnavailable }: TapToPayProps) {
  useEffect(() => {
    const bridge = getTapToPayBridgeForTests();
    if (bridge) onReady(bridge);
    else
      onUnavailable({
        kind: "unsupported",
        code: null,
        message: "Tap to Pay is not available on this device.",
      });
  }, [onReady, onUnavailable]);
  return null;
}
