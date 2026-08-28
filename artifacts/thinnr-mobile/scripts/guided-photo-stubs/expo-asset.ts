/**
 * Node stand-in for expo-asset. The web demo capture resolves a bundled
 * pose illustration to a displayable URI via Asset.fromModule; the stubbed
 * pose-image sentinels carry their angle, so the resulting URI names it.
 */
export const assetState = {
  resolved: [] as unknown[],
  reset(): void {
    assetState.resolved.length = 0;
  },
};

export class Asset {
  readonly uri: string;
  readonly width = 1080;
  readonly height = 1440;

  private constructor(module: unknown) {
    const angle = (module as { angle?: unknown } | null)?.angle;
    this.uri = `asset://pose-${typeof angle === 'string' ? angle : String(module)}`;
  }

  static fromModule(module: unknown): Asset {
    assetState.resolved.push(module);
    return new Asset(module);
  }

  async downloadAsync(): Promise<Asset> {
    return this;
  }
}
