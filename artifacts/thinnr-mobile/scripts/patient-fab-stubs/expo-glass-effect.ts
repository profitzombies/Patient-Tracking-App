/** Node stand-in for expo-glass-effect; the suite pins the classic layout. */
let liquidGlass = false;

export function setLiquidGlassAvailable(value: boolean): void {
  liquidGlass = value;
}

export function isLiquidGlassAvailable(): boolean {
  return liquidGlass;
}
