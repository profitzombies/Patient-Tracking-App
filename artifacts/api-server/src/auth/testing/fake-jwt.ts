/**
 * Test-only ES256 signer that mimics GoTrue's asymmetric access tokens so
 * suites can exercise local verification without a live Supabase project:
 * a keypair, the JWKS document GoTrue would publish for it, and a `sign`
 * helper producing compact JWTs with the claims GoTrue stamps.
 */
import { createPrivateKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

export interface FakeSigner {
  kid: string;
  privateKey: KeyObject;
  /** The `{ keys: [...] }` body a JWKS endpoint would return for this key. */
  jwks(): { keys: Array<Record<string, unknown>> };
  /** Public JWK only (for composing multi-key JWKS documents). */
  publicJwk(): Record<string, unknown>;
  /** Sign a payload; missing standard claims are filled with sane defaults. */
  sign(
    payload: Record<string, unknown>,
    options?: { alg?: string; kid?: string | null; issuer?: string; nowSeconds?: number; ttlSeconds?: number },
  ): string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function createFakeSigner(input: { kid?: string; issuer: string } ): FakeSigner {
  const kid = input.kid ?? `test-${Math.random().toString(36).slice(2, 10)}`;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, alg: "ES256", use: "sig" };
  return {
    kid,
    privateKey,
    publicJwk: () => ({ ...publicJwk }),
    jwks: () => ({ keys: [{ ...publicJwk }] }),
    sign(payload, options = {}) {
      const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
      const header: Record<string, unknown> = { alg: options.alg ?? "ES256", typ: "JWT" };
      if (options.kid !== null) header.kid = options.kid ?? kid;
      const claims: Record<string, unknown> = {
        iss: options.issuer ?? input.issuer,
        aud: "authenticated",
        role: "authenticated",
        iat: nowSeconds,
        exp: nowSeconds + (options.ttlSeconds ?? 3600),
        ...payload,
      };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
      const signer = createSign("sha256");
      signer.update(signingInput);
      signer.end();
      const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
      return `${signingInput}.${b64url(signature)}`;
    },
  };
}

/** A second, unrelated private key — for "tampered / foreign signature" cases. */
export function foreignPrivateKey(): KeyObject {
  return createPrivateKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }));
}
