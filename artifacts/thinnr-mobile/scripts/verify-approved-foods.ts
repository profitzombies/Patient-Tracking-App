/**
 * Approved-foods verbatim check.
 *
 * Compares every program-wording string in data/approved-foods.ts back to the
 * canonical archive (docs/thinnr-program/approved-foods.md) so no paraphrasing
 * or "typo fixing" can creep in, and reconciles item counts against the
 * source's bullet and table-row counts so nothing is silently dropped.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:approved-foods
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_FOOD_CATEGORIES,
  APPROVED_GROUPS,
  APPROVED_ITEMS,
  APPROVED_MATCH_BY_FOOD,
  FOOD_BY_APPROVED_ITEM,
} from '../data/approved-foods';
import { FOOD_DB } from '../data/patient-data';

const SOURCE_PATH = fileURLToPath(new URL('../../../docs/thinnr-program/approved-foods.md', import.meta.url));
const source = readFileSync(SOURCE_PATH, 'utf8');

/** Collapse all whitespace so two-column layout and wrapping don't matter. */
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
const sourceNorm = normalize(source);

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

/** Assert `text` appears verbatim (whitespace-insensitive) in the source. */
function verbatim(label: string, text: string | undefined) {
  if (text === undefined) return;
  checks += 1;
  if (!sourceNorm.includes(normalize(text))) {
    fail(`not verbatim in source — ${label}:\n        "${text}"`);
  }
}

function expectEqual(label: string, actual: number, expected: number) {
  checks += 1;
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

// ── 1. Every program-wording string must appear verbatim in the archive ─────
for (const group of Object.values(APPROVED_GROUPS)) {
  verbatim('group title', group.title);
  verbatim('group note', group.note);
}

const seenItemIds = new Set<string>();
const seenCategoryIds = new Set<string>();
for (const category of APPROVED_FOOD_CATEGORIES) {
  if (seenCategoryIds.has(category.id)) fail(`duplicate category id ${category.id}`);
  seenCategoryIds.add(category.id);

  verbatim(`category title (${category.id})`, category.title);
  verbatim(`category note (${category.id})`, category.note);
  verbatim(`category itemPortion (${category.id})`, category.itemPortion);

  for (const item of category.items) {
    if (seenItemIds.has(item.id)) fail(`duplicate item id ${item.id}`);
    seenItemIds.add(item.id);

    if (item.nameParts) {
      // Wording wraps across interleaved two-column lines in the source, so
      // the full name is not contiguous — each per-line fragment must be.
      checks += 1;
      if (item.nameParts.join(' ') !== item.name) {
        fail(`nameParts do not reassemble name for ${item.id}`);
      }
      for (const part of item.nameParts) verbatim(`name fragment (${item.id})`, part);
    } else {
      verbatim(`item name (${item.id})`, item.name);
    }
    verbatim(`item portion (${item.id})`, item.portion);
    verbatim(`item benefit (${item.id})`, item.benefit);
  }
}

// ── 2. Count reconciliation: nothing dropped, nothing invented ───────────────
const bulletCount = (source.match(/•/g) ?? []).length;
const bulletedItems = APPROVED_ITEMS.filter(i => i.bulleted).length;
expectEqual('source • bullets vs bulleted items', bulletedItems, bulletCount);

const tableRows = source
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('|'))
  .map(line => (line.split('|')[1] ?? '').trim())
  .filter(cell => cell !== '' && cell !== 'FOOD' && cell !== 'OIL/FAT' && !/^-+$/.test(cell)).length;
const tableItems = APPROVED_ITEMS.filter(i => !i.bulleted && i.benefit !== undefined).length;
expectEqual('source table rows vs normalization items', tableItems, tableRows);

// Tripwire: full inventory (9 beef + 4 pork + 8 poultry + 1 lunchmeat rule +
// 18 seafood + 42 vegetables + 39 fruits + 7 bread/grain + 27 free vegetables +
// 1 cooking-spray rule + 17 seasonings + 10 normalization foods + 10 oils).
expectEqual('total approved items', APPROVED_ITEMS.length, 193);

// ── 3. Food matches: real foods on one side, real approved items on the other ─
const foodIds = new Set(FOOD_DB.map(f => f.id));
for (const [foodId, approvedId] of Object.entries(APPROVED_MATCH_BY_FOOD)) {
  checks += 1;
  if (!foodIds.has(foodId)) fail(`APPROVED_MATCH_BY_FOOD key is not a seeded food: ${foodId}`);
  checks += 1;
  if (!seenItemIds.has(approvedId)) fail(`APPROVED_MATCH_BY_FOOD value is not an approved item: ${approvedId}`);
  checks += 1;
  if (foodId.startsWith('custom_')) fail(`custom foods must never be approved: ${foodId}`);
}
for (const [approvedId, foodId] of Object.entries(FOOD_BY_APPROVED_ITEM)) {
  checks += 1;
  if (APPROVED_MATCH_BY_FOOD[foodId] !== approvedId) {
    fail(`FOOD_BY_APPROVED_ITEM inconsistent for ${approvedId} → ${foodId}`);
  }
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ approved-foods verbatim check: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ approved-foods verbatim check: ${checks} checks passed`);
console.log(`  ${APPROVED_FOOD_CATEGORIES.length} categories, ${APPROVED_ITEMS.length} items, ${Object.keys(APPROVED_MATCH_BY_FOOD).length} matched database foods`);
