#!/usr/bin/env node
/**
 * Verifies every program quote in data/restaurant-guide.json appears verbatim
 * in the official THINNR docs archive (docs/thinnr-program/).
 *
 * Guard for the verbatim-sources rule: official program wording must be
 * quoted exactly — never paraphrased, "corrected", or reordered. The only
 * transformation allowed between archive and app is whitespace
 * normalization (joining hard-wrapped lines and collapsing space runs),
 * which this check applies identically to both sides before comparing.
 *
 * Run: node scripts/check-restaurant-guide-verbatim.mjs
 * Exits non-zero if any quoted string is missing from the archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const archiveDir = path.resolve(mobileRoot, '../../docs/thinnr-program');

// Join wrapped lines, collapse whitespace runs. Wording stays byte-exact.
const flow = raw => raw.split('\n').map(l => l.trim()).join(' ').replace(/ +/g, ' ');

const docs = ['program-instructions.md', 'protocol-knowledge-base.txt', 'manual-transcription.md'].map(
  name => ({ name, text: flow(fs.readFileSync(path.join(archiveDir, name), 'utf8')) }),
);

const guidePath = path.join(mobileRoot, 'data', 'restaurant-guide.json');
const guide = JSON.parse(fs.readFileSync(guidePath, 'utf8'));

let checked = 0;
const failures = [];

for (const section of guide.sections) {
  for (const [qi, quote] of section.quotes.entries()) {
    if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
      failures.push({ where: `${section.key}[${qi}]`, str: '(quote has no lines)' });
      continue;
    }
    if (typeof quote.source !== 'string' || quote.source.length === 0) {
      failures.push({ where: `${section.key}[${qi}]`, str: '(quote has no source)' });
    }
    const strings = [...(quote.question ? [quote.question] : []), ...quote.lines];
    for (const str of strings) {
      checked += 1;
      if (!docs.some(d => d.text.includes(str))) {
        failures.push({ where: `${section.key}[${qi}]`, str });
      }
    }
  }
}

if (checked === 0) {
  console.error('restaurant-guide verbatim check: no quotes found — data file is empty or malformed.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`restaurant-guide verbatim check FAILED — ${failures.length} string(s) not found in the archive:`);
  for (const f of failures) {
    console.error(`\n  [${f.where}]\n  ${JSON.stringify(f.str)}`);
  }
  process.exit(1);
}

console.log(`restaurant-guide verbatim check passed — ${checked} quoted strings verified against ${docs.map(d => d.name).join(', ')}.`);
