/**
 * Deterministic e2e fixtures for the create-food label scan.
 *
 * Draws two PNGs with zero dependencies (raw RGB scanlines + node:zlib, a
 * 5x7 pixel font scaled up until it is crisp):
 *
 *   nutrition-label.png — a classic Nutrition Facts panel with distinctive
 *     values (235 cal / 9g fat / 34g carbs / 7g protein, 3/4 cup serving).
 *     The numbers are deliberately unusual so an e2e prefill check proves
 *     the model read THIS image rather than guessing defaults.
 *
 *   not-a-label.png — a child's-drawing house scene, for the warm re-ask
 *     path (clearly a photo of something, clearly not a label).
 *
 * Run: node artifacts/thinnr-mobile/scripts/e2e-fixtures/make-fixtures.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Minimal PNG encoder (RGB, no filters) ───────────────────────────────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(canvas) {
  const { width, height, pixels } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    // leading 0 = "no filter" for the scanline
    pixels.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Tiny raster canvas ──────────────────────────────────────────────────────

function makeCanvas(width, height, [r, g, b]) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = r;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = b;
  }
  return { width, height, pixels };
}

function fillRect(canvas, x, y, w, h, [r, g, b]) {
  const x1 = Math.min(canvas.width, x + w);
  const y1 = Math.min(canvas.height, y + h);
  for (let py = Math.max(0, y); py < y1; py += 1) {
    for (let px = Math.max(0, x); px < x1; px += 1) {
      const i = (py * canvas.width + px) * 3;
      canvas.pixels[i] = r;
      canvas.pixels[i + 1] = g;
      canvas.pixels[i + 2] = b;
    }
  }
}

// ─── 5x7 pixel font (uppercase + digits + label punctuation) ────────────────

const FONT = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '/': [0b00001, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000],
  '.': [0, 0, 0, 0, 0, 0b00110, 0b00110],
  '%': [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  '-': [0, 0, 0, 0b01110, 0, 0, 0],
  ':': [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0],
};

/** Draws text at (x, y); each font pixel becomes a scale×scale block. */
function drawText(canvas, x, y, text, scale, color) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for "${ch}"`);
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row] & (1 << (4 - col))) {
          fillRect(canvas, cx + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cx += 6 * scale; // 5px glyph + 1px gap
  }
  return cx;
}

function textWidth(text, scale) {
  return text.length * 6 * scale - scale;
}

// ─── Fixture 1: the Nutrition Facts panel ────────────────────────────────────

const BLACK = [10, 10, 10];
const WHITE = [255, 255, 255];

function makeLabel() {
  const W = 640;
  const H = 900;
  const canvas = makeCanvas(W, H, WHITE);
  const M = 24; // outer margin / border inset
  const PAD = M + 18;

  // Heavy outer border, like the FDA panel.
  fillRect(canvas, M, M, W - 2 * M, 6, BLACK);
  fillRect(canvas, M, H - M - 6, W - 2 * M, 6, BLACK);
  fillRect(canvas, M, M, 6, H - 2 * M, BLACK);
  fillRect(canvas, W - M - 6, M, 6, H - 2 * M, BLACK);

  let y = M + 30;
  drawText(canvas, PAD, y, 'NUTRITION', 9, BLACK);
  y += 7 * 9 + 12;
  drawText(canvas, PAD, y, 'FACTS', 9, BLACK);
  y += 7 * 9 + 22;

  fillRect(canvas, PAD, y, W - 2 * PAD, 3, BLACK);
  y += 18;
  drawText(canvas, PAD, y, '7 SERVINGS PER CONTAINER', 3, BLACK);
  y += 7 * 3 + 14;
  drawText(canvas, PAD, y, 'SERVING SIZE 3/4 CUP (61G)', 4, BLACK);
  y += 7 * 4 + 20;

  // The thick calories bar.
  fillRect(canvas, PAD, y, W - 2 * PAD, 12, BLACK);
  y += 26;
  drawText(canvas, PAD, y, 'AMOUNT PER SERVING', 3, BLACK);
  y += 7 * 3 + 14;
  drawText(canvas, PAD, y, 'CALORIES', 6, BLACK);
  drawText(canvas, W - PAD - textWidth('235', 10), y - 8, '235', 10, BLACK);
  y += 7 * 10 + 4;

  fillRect(canvas, PAD, y, W - 2 * PAD, 8, BLACK);
  y += 22;

  const rows = [
    ['TOTAL FAT 9G', true],
    ['SODIUM 170MG', true],
    ['TOTAL CARBOHYDRATE 34G', true],
    ['DIETARY FIBER 5G', false],
    ['TOTAL SUGARS 11G', false],
    ['PROTEIN 7G', true],
  ];
  for (const [text, major] of rows) {
    drawText(canvas, major ? PAD : PAD + 30, y, text, 4, BLACK);
    y += 7 * 4 + 12;
    fillRect(canvas, PAD, y, W - 2 * PAD, major ? 3 : 1, BLACK);
    y += 16;
  }

  writeFileSync(join(OUT_DIR, 'nutrition-label.png'), encodePng(canvas));
  console.log('wrote nutrition-label.png');
}

// ─── Fixture 2: clearly not a label ──────────────────────────────────────────

function makeNotALabel() {
  const W = 640;
  const H = 480;
  const canvas = makeCanvas(W, H, [140, 195, 240]); // sky

  fillRect(canvas, 0, 360, W, 120, [96, 168, 88]); // grass
  // Sun (blocky circle).
  const sun = [110, 60, 42];
  for (let dy = -42; dy <= 42; dy += 6) {
    const half = Math.floor(Math.sqrt(42 * 42 - dy * dy));
    fillRect(canvas, sun[0] - half, sun[1] + dy, half * 2, 6, [250, 210, 70]);
  }
  // House.
  fillRect(canvas, 240, 220, 200, 150, [205, 92, 72]); // walls
  for (let step = 0; step < 12; step += 1) {
    // Roof: stacked, narrowing slabs.
    fillRect(canvas, 232 + step * 9, 220 - (step + 1) * 8, 216 - step * 18, 8, [120, 72, 52]);
  }
  fillRect(canvas, 310, 290, 60, 80, [88, 58, 44]); // door
  fillRect(canvas, 258, 250, 44, 40, [230, 240, 250]); // window
  fillRect(canvas, 396, 250, 3, 40, [120, 72, 52]);

  writeFileSync(join(OUT_DIR, 'not-a-label.png'), encodePng(canvas));
  console.log('wrote not-a-label.png');
}

makeLabel();
makeNotALabel();
