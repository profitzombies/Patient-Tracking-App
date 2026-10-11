/**
 * Node stand-in for expo-constants: the consent screen stamps the app version
 * and the Tap to Pay gate reads the build-time flag under extra.thinnr.
 * Defaults to a build WITHOUT Tap to Pay (what preview and production ship
 * until Apple grants the entitlement); suites that exercise the tap flow
 * flip `setTapToPayBuildFlagForTests(true)` explicitly.
 */
export interface StubExpoConfig {
  version?: string;
  extra?: { thinnr?: { tapToPay?: boolean; buildProfile?: string } };
}
const Constants = {
  expoConfig: { version: '1.0.0-test', extra: {} } as StubExpoConfig,
  appOwnership: null as string | null,
  executionEnvironment: 'bare',
  isDevice: false,
};
export function setTapToPayBuildFlagForTests(enabled: boolean) {
  Constants.expoConfig.extra = { ...(Constants.expoConfig.extra ?? {}), thinnr: { tapToPay: enabled } };
}
export default Constants;
