/**
 * Tap to Pay seam between the Sell to patient screen and the Stripe Terminal
 * SDK. The screen only ever talks to a `TapToPayClient`; the native component
 * builds one from the SDK, the Node verification harness installs a scripted
 * one here, and web/Expo Go never produce one at all.
 */
export type TapFailureKind = "unsupported" | "declined" | "canceled" | "error";
export interface TapFailure {
  kind: TapFailureKind;
  /** Terminal SDK error code when there was one, for logs and support. */
  code: string | null;
  message: string;
}
export type TapResult = { ok: true } | { ok: false; failure: TapFailure };

export interface TapConnectParams {
  locationId: string;
  /** Stripe test mode: register the SDK's simulated Tap to Pay reader. */
  simulated: boolean;
}

export interface TapToPayClient {
  /** Registers this phone as a Tap to Pay reader at the office's location. */
  connect(params: TapConnectParams): Promise<TapResult>;
  /** Shows the system tap screen for one card-present intent and confirms it. */
  collect(clientSecret: string): Promise<TapResult>;
  /** Dismisses an in-progress tap screen, if any. */
  cancelCollect(): Promise<void>;
  disconnect(): Promise<void>;
}

export const TAP_DEVICE_HINT =
  "Tap to Pay needs an iPhone XS or newer on a recent iOS, or an Android phone with NFC.";

const UNSUPPORTED_MESSAGES: Record<string, string> = {
  TAP_TO_PAY_UNSUPPORTED_DEVICE: `This phone cannot take Tap to Pay. ${TAP_DEVICE_HINT}`,
  TAP_TO_PAY_UNSUPPORTED_ANDROID_VERSION:
    "This phone's Android version is too old for Tap to Pay.",
  TAP_TO_PAY_UNSUPPORTED_PROCESSOR: `This phone cannot take Tap to Pay. ${TAP_DEVICE_HINT}`,
  TAP_TO_PAY_LIBRARY_NOT_INCLUDED:
    "This build of THINNR is not entitled for Tap to Pay yet. Use the card form or QR code.",
  TAP_TO_PAY_DEBUG_NOT_SUPPORTED:
    "Tap to Pay does not run in debug builds. Use a TestFlight or store build.",
  TAP_TO_PAY_DEVICE_TAMPERED:
    "This phone failed Stripe's security check and cannot take Tap to Pay.",
  TAP_TO_PAY_INSECURE_ENVIRONMENT:
    "This phone failed Stripe's security check and cannot take Tap to Pay.",
  TAP_TO_PAY_NFC_DISABLED: "Turn on NFC in this phone's settings to take Tap to Pay.",
  LOCATION_SERVICES_DISABLED:
    "Allow location access for THINNR; Stripe requires it to take in-person payments.",
  TAP_TO_PAY_READER_MERCHANT_BLOCKED:
    "Stripe has blocked Tap to Pay for this office's account. Use the card form or QR code.",
};

/** Turns a Terminal SDK error into the failure the screen shows and reports. */
export function describeTerminalError(
  error: { code?: string | null; message?: string | null; apiError?: { message?: string | null } | null } | null | undefined,
  fallback = "Tap to Pay hit a problem. Try again or use another payment method.",
): TapFailure {
  const code = error?.code ?? null;
  if (code && UNSUPPORTED_MESSAGES[code]) return { kind: "unsupported", code, message: UNSUPPORTED_MESSAGES[code] };
  if (code === "CANCELED") return { kind: "canceled", code, message: "The tap was canceled before the patient tapped." };
  if (code === "DECLINED_BY_STRIPE_API" || code === "DECLINED_BY_READER" || code === "OFFLINE_TRANSACTION_DECLINED") {
    const detail = error?.apiError?.message?.trim() || error?.message?.trim();
    return { kind: "declined", code, message: detail ? `The card was declined: ${detail}` : "The card was declined." };
  }
  const message = error?.message?.trim();
  return { kind: "error", code, message: message ? `Tap to Pay failed: ${message}` : fallback };
}

export function isTapFailure(value: unknown): value is TapFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof (value as TapFailure).message === "string"
  );
}

let bridge: TapToPayClient | null = null;
/** Node verification only: the client the fallback TapToPay component hands to the screen. */
export function setTapToPayBridgeForTests(client: TapToPayClient | null): void {
  bridge = client;
}
export function getTapToPayBridgeForTests(): TapToPayClient | null {
  return bridge;
}
