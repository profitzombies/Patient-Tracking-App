/**
 * Synthesizes the guided photo session's two sounds as tiny PCM WAVs:
 *
 * - countdown-tick.wav — a crisp 70 ms blip played on each countdown second
 * - capture-tone.wav   — a rising two-note chime marking the auto-capture
 *
 * Pure Node, no dependencies; run once and commit the outputs:
 *   node scripts/generate-guided-photo-sounds.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;

/** Int16 mono samples → RIFF/WAVE file bytes. */
function wavFile(samples) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

/** A sine tone with a fast attack and polynomial decay — no clicks. */
function tone(freq, ms, { gain = 0.5, decayPow = 3 } = {}) {
  const n = Math.round((RATE * ms) / 1000);
  const attackSamples = Math.round(RATE * 0.004);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, i / attackSamples);
    const decay = Math.pow(1 - i / n, decayPow);
    out[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * attack * decay * gain * 32767);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'assets', 'sounds');
mkdirSync(outDir, { recursive: true });

// Tick: one short high blip — audible from across a room without being harsh.
const tick = tone(1080, 70, { gain: 0.45, decayPow: 2.5 });
writeFileSync(join(outDir, 'countdown-tick.wav'), wavFile(tick));

// Capture: two rising notes (A5 → E6) so "photo taken" reads clearly
// different from the per-second tick even without looking at the screen.
const capture = concat(tone(880, 130, { gain: 0.5, decayPow: 2 }), tone(1318.5, 290, { gain: 0.55, decayPow: 2.5 }));
writeFileSync(join(outDir, 'capture-tone.wav'), wavFile(capture));

console.log('wrote', join(outDir, 'countdown-tick.wav'), tick.length * 2 + 44, 'bytes');
console.log('wrote', join(outDir, 'capture-tone.wav'), capture.length * 2 + 44, 'bytes');
