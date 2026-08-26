/**
 * Node stand-in for expo-image-manipulator, mirroring the fluent API
 * photo-prep uses (manipulate → resize? → renderAsync → saveAsync). The
 * "encoded" output simply reuses the source's base64 payload, so the suite
 * can assert that the exact bytes the picker produced are what the scan
 * uploads.
 */
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' } as const;

class FakeRendered {
  constructor(private readonly base64: string) {}

  async saveAsync(_options: { format?: string; compress?: number; base64?: boolean }): Promise<{
    uri: string;
    base64: string;
    width: number;
    height: number;
  }> {
    return {
      uri: `data:image/jpeg;base64,${this.base64}`,
      base64: this.base64,
      width: 1200,
      height: 1600,
    };
  }
}

class FakeContext {
  constructor(private readonly sourceUri: string) {}

  resize(_spec: Record<string, number>): this {
    return this;
  }

  async renderAsync(): Promise<FakeRendered> {
    const base64 = this.sourceUri.startsWith('data:')
      ? this.sourceUri.slice(this.sourceUri.indexOf(',') + 1)
      : Buffer.from(this.sourceUri).toString('base64');
    return new FakeRendered(base64);
  }
}

export const ImageManipulator = {
  manipulate(uri: string): FakeContext {
    return new FakeContext(uri);
  },
};
