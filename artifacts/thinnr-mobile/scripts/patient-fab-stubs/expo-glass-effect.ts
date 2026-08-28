/**
 * Node stand-in for expo-glass-effect: report no liquid glass so the
 * patient layout takes its classic (Tabs) branch — the same branch web and
 * Android run. The launcher mounts OUTSIDE the branch, so the suite's
 * coverage does not depend on which variant renders.
 */
export function isLiquidGlassAvailable(): boolean {
  return false;
}
