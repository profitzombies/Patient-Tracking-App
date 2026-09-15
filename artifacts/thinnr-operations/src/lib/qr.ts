/**
 * Client-side QR encoding for the office "Get the app" panel.
 *
 * Codes are computed locally from the exact link HQ saved (no external
 * image service ever sees the URL) and rendered as a single SVG path, which
 * is DOM-free — the same helper feeds the on-screen panel, the printable
 * sheet, and the Node verification suite.
 */
import QRCode from 'qrcode';

export interface QrMatrix {
  /** Modules per side. */
  size: number;
  /** Row-major dark flags, `size * size` long. */
  dark: boolean[];
}

/** Error-correction M: the standard for URL codes scanned from a phone at arm's length. */
export function qrMatrix(text: string): QrMatrix {
  const code = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = code.modules.size;
  const data = code.modules.data as ArrayLike<number | boolean>;
  const dark: boolean[] = [];
  for (let index = 0; index < size * size; index += 1) dark.push(Boolean(data[index]));
  return { size, dark };
}

/**
 * One SVG path covering every dark module, in a `0 0 size size` user space
 * (add the quiet zone with the viewBox, see `qrViewBox`). Horizontal runs
 * collapse into one rectangle each so the path stays short.
 */
export function qrPath({ size, dark }: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!dark[row * size + col]) { col += 1; continue; }
      let run = 1;
      while (col + run < size && dark[row * size + col + run]) run += 1;
      parts.push(`M${col} ${row}h${run}v1h-${run}z`);
      col += run;
    }
  }
  return parts.join('');
}

/** The spec's four-module quiet zone on every side. */
export const QR_QUIET_ZONE = 4;

export function qrViewBox(size: number): string {
  return `${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${size + QR_QUIET_ZONE * 2} ${size + QR_QUIET_ZONE * 2}`;
}

/** Standalone SVG markup (for the printable sheet / downloads). */
export function qrSvgMarkup(text: string, sizePx: number, label: string): string {
  const matrix = qrMatrix(text);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${qrViewBox(matrix.size)}" width="${sizePx}" height="${sizePx}" role="img" aria-label="${escapeAttr(label)}" shape-rendering="crispEdges">` +
    `<rect x="${-QR_QUIET_ZONE}" y="${-QR_QUIET_ZONE}" width="${matrix.size + QR_QUIET_ZONE * 2}" height="${matrix.size + QR_QUIET_ZONE * 2}" fill="#ffffff"/>` +
    `<path d="${qrPath(matrix)}" fill="#203b64"/>` +
    `</svg>`
  );
}

export function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
