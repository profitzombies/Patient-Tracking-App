import { Platform } from "react-native";
import Constants from "expo-constants";
import { getTapToPayBridgeForTests } from "@/lib/tap-to-pay-bridge";

/**
 * Whether this binary was built WITH Tap to Pay: app.config.js adds the Apple
 * proximity-reader entitlement, the Stripe Terminal module and the NFC /
 * location permissions only when TAP_TO_PAY_ENABLED=1 at build time, and
 * records that decision under extra.thinnr.tapToPay. Store builds ship with
 * it off until Apple grants the entitlement, so a production install must
 * never offer the option — even when the office is fully set up and the API
 * reports Tap to Pay available — because the sale would be staged and then
 * fail at reader connection with no entitlement or permission to fall back on.
 */
export function tapToPayBuildEnabled(): boolean {
  const extra = Constants.expoConfig?.extra as
    | { thinnr?: { tapToPay?: unknown } }
    | undefined;
  return extra?.thinnr?.tapToPay === true;
}

/**
 * Whether this app instance can even try Tap to Pay: a native store or
 * development build that was compiled with the feature on. Web has no NFC
 * path, and Expo Go cannot load the Stripe Terminal module. The definitive
 * device and entitlement checks come from the SDK itself once the option is
 * chosen, and surface inline on the screen.
 */
export function tapToPayDeviceSupported(): boolean {
  if (!tapToPayBuildEnabled()) return false;
  if (getTapToPayBridgeForTests()) return true;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return false;
  const expoGo =
    Constants.appOwnership === "expo" ||
    Constants.executionEnvironment === "storeClient";
  return !expoGo;
}
