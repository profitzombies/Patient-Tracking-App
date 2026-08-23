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
 * Checked content:
 * - `beforeYouOrder` + `sections` — every quoted question and line, per quote.
 * - `directory` — the guide tagline, every restaurant name, and every
 *   approved order line, plus structural tripwires: unique ids, non-empty
 *   orders, restaurants listed in the document's order, and count matches
 *   against the guide document's own bullet/heading lines so silently
 *   dropped or invented entries fail loudly.
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

const DOC_NAMES = [
  'program-instructions.md',
  'protocol-knowledge-base.txt',
  'manual-transcription.md',
  'restaurant-guide.txt',
];
const docs = DOC_NAMES.map(name => {
  const rawText = fs.readFileSync(path.join(archiveDir, name), 'utf8');
  return { name, raw: rawText, text: flow(rawText) };
});
const restaurantDoc = docs.find(d => d.name === 'restaurant-guide.txt');

const guidePath = path.join(mobileRoot, 'data', 'restaurant-guide.json');
const guide = JSON.parse(fs.readFileSync(guidePath, 'utf8'));

let checked = 0;
const failures = [];

const verify = (where, str) => {
  checked += 1;
  if (typeof str !== 'string' || str.length === 0 || !docs.some(d => d.text.includes(str))) {
    failures.push({ where, str: typeof str === 'string' ? str : '(not a string)' });
  }
};

// ── Quoted guidance: Before-you-order rules + the manual/KB sections ────────
const sections = [guide.beforeYouOrder, ...(guide.sections ?? [])].filter(Boolean);
for (const section of sections) {
  for (const [qi, quote] of (section.quotes ?? []).entries()) {
    if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
      failures.push({ where: `${section.key}[${qi}]`, str: '(quote has no lines)' });
      continue;
    }
    if (typeof quote.source !== 'string' || quote.source.length === 0) {
      failures.push({ where: `${section.key}[${qi}]`, str: '(quote has no source)' });
    }
    if (quote.question) verify(`${section.key}[${qi}]`, quote.question);
    for (const line of quote.lines) verify(`${section.key}[${qi}]`, line);
  }
}

// The document's own bullet counts are the tripwire for dropped/invented
// rules. Furniture lines (page headers, the © footer) never start with "•".
const OPTIONS_MARKER = 'THINNR-APPROVED RESTAURANT OPTIONS';
const RULES_MARKER = 'BEFORE YOU ORDER';
const bulletCount = text => text.split('\n').filter(l => l.trim().startsWith('•')).length;
const rulesRegion = restaurantDoc.raw.slice(
  restaurantDoc.raw.indexOf(RULES_MARKER),
  restaurantDoc.raw.indexOf(OPTIONS_MARKER),
);
const docRuleCount = bulletCount(rulesRegion);
const ruleQuoteCount = guide.beforeYouOrder?.quotes?.length ?? 0;
if (ruleQuoteCount !== docRuleCount) {
  failures.push({
    where: 'beforeYouOrder',
    str: `(rule count ${ruleQuoteCount} != ${docRuleCount} bullet lines under BEFORE YOU ORDER in the guide document)`,
  });
}

// ── Restaurant directory ────────────────────────────────────────────────────
const directory = guide.directory ?? {};
verify('directory.tagline', directory.tagline);
if (typeof directory.source !== 'string' || directory.source.length === 0) {
  failures.push({ where: 'directory', str: '(directory has no source)' });
}

const restaurants = Array.isArray(directory.restaurants) ? directory.restaurants : [];
if (restaurants.length === 0) {
  failures.push({ where: 'directory.restaurants', str: '(no restaurants in the directory)' });
}

const seenIds = new Set();
let orderLineCount = 0;
let prevPos = -1;
let prevName = '(start of document)';
for (const [ri, restaurant] of restaurants.entries()) {
  const where = `restaurants[${ri}]${typeof restaurant.id === 'string' ? ` ${restaurant.id}` : ''}`;
  if (typeof restaurant.id !== 'string' || restaurant.id.length === 0) {
    failures.push({ where, str: '(restaurant has no id)' });
  } else if (seenIds.has(restaurant.id)) {
    failures.push({ where, str: `(duplicate restaurant id "${restaurant.id}")` });
  } else {
    seenIds.add(restaurant.id);
  }

  verify(where, restaurant.name);

  // The app must list restaurants in the document's order; compare first
  // occurrences of each verbatim name in the guide document.
  if (typeof restaurant.name === 'string' && restaurant.name.length > 0) {
    const pos = restaurantDoc.text.indexOf(restaurant.name);
    if (pos !== -1) {
      if (pos <= prevPos) {
        failures.push({
          where,
          str: `(out of document order — "${restaurant.name}" precedes "${prevName}" in the guide)`,
        });
      }
      prevPos = pos;
      prevName = restaurant.name;
    }
  }

  if (!Array.isArray(restaurant.orders) || restaurant.orders.length === 0) {
    failures.push({ where, str: '(restaurant has no orders)' });
    continue;
  }
  for (const [oi, order] of restaurant.orders.entries()) {
    orderLineCount += 1;
    verify(`${where}.orders[${oi}]`, order);
  }
}

// Count tripwires against the document itself. In the paste, every approved
// order is a line starting with "•"; a restaurant heading is any other
// non-empty, non-furniture line that does not start lowercase (hard-wrapped
// bullet continuations always start lowercase in this document).
const FURNITURE = new Set(['THINNRRESTAURANT GUIDE', '© 2025-6 SlimCell • All rights reserved']);
const directoryRegion = restaurantDoc.raw.slice(restaurantDoc.raw.indexOf(OPTIONS_MARKER));
const docOrderCount = bulletCount(directoryRegion);
const docHeadingCount = directoryRegion
  .split('\n')
  .slice(1) // drop the OPTIONS_MARKER line itself
  .map(l => l.trim())
  .filter(l => l.length > 0 && !l.startsWith('•') && !FURNITURE.has(l) && !/^[a-z]/.test(l)).length;
if (restaurants.length > 0 && restaurants.length !== docHeadingCount) {
  failures.push({
    where: 'directory.restaurants',
    str: `(restaurant count ${restaurants.length} != ${docHeadingCount} headings in the guide document)`,
  });
}
if (restaurants.length > 0 && orderLineCount !== docOrderCount) {
  failures.push({
    where: 'directory.restaurants',
    str: `(order-line count ${orderLineCount} != ${docOrderCount} bullet lines in the guide document)`,
  });
}

if (checked === 0) {
  console.error('restaurant-guide verbatim check: no quotes found — data file is empty or malformed.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`restaurant-guide verbatim check FAILED — ${failures.length} problem(s):`);
  for (const f of failures) {
    console.error(`\n  [${f.where}]\n  ${JSON.stringify(f.str)}`);
  }
  process.exit(1);
}

console.log(
  `restaurant-guide verbatim check passed — ${checked} quoted strings verified ` +
    `(${sections.length} guidance sections; ${restaurants.length} restaurants, ${orderLineCount} order lines) ` +
    `against ${docs.map(d => d.name).join(', ')}.`,
);
