import { useEffect } from "react";
import type { TapToPayProps } from "./TapToPay";

/** Browsers have no NFC payment path: the screen never offers Tap to Pay here, but stays honest if reached. */
export default function TapToPay({ onUnavailable }: TapToPayProps) {
  useEffect(() => {
    onUnavailable({
      kind: "unsupported",
      code: null,
      message:
        "Tap to Pay only works in the THINNR app on a phone. Use the card form or QR code.",
    });
  }, [onUnavailable]);
  return null;
}
