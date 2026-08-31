/**
 * Plain base64 → bytes with zero imports, so any module can decode data
 * URIs without dragging native dependencies into its graph. photo-probe
 * re-exports this for its PNG pipeline; patient-data-api uses it to turn
 * library photo data URIs into upload bytes. Works identically in Hermes,
 * browsers, and Node.
 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Plain base64 → bytes; works identically in Hermes, browsers, and Node. */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = BASE64_LOOKUP[clean.charCodeAt(i)];
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}
