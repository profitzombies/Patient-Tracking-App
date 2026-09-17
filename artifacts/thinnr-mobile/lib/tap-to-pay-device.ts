import { Platform } from "react-native";
import Constants from "expo-constants";
import { getTapToPayBridgeForTests } from "@/lib/tap-to-pay-bridge";

/**
 * Whether this app instance can even try Tap to Pay: a native store or
 * development build. Web has no NFC path, and Expo Go cannot load the Stripe
 * Terminal module. The definitive device and entitlement checks come from the
 * SDK itself once the option is chosen, and surface inline on the screen.
 */
export function tapToPayDeviceSupported(): boolean {
  if (getTapToPayBridgeForTests()) return true;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return false;
  const expoGo =
    Constants.appOwnership === "expo" ||
    Constants.executionEnvironment === "storeClient";
  return !expoGo;
}
