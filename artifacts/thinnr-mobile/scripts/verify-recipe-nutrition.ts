/**
 * Ingredient breakdown invariants.
 *
 * Pins the pure math and data contracts behind "tap into a recipe's
 * ingredients and edit amounts":
 *   1. Curated catalog integrity — every amount>0 ingredient carries integer
 *      per-ingredient nutrition and each macro sums EXACTLY to the recipe's
 *      per-serving totals; "to taste" rows stay bare.
 *   2. Unit families + scaling — linear conversions inside weight/volume
 *      families, null across families, and every rescale derived from the
 *      ORIGINAL baseline (no compounding through repeated edits).
 *   3. Adjusted totals — delta method against stated totals, exact when
 *      unadjusted, clamped at zero, rounded once at the log boundary.
 *   4. Adjustment hygiene — sanitizeAdjustments drops garbage, dedupes,
 *      clamps, and treats return-to-original as deletion.
 *   5. AI payload parsing — per-ingredient nutrition survives when well
 *      formed and is dropped (without killing the card) when malformed.
 *   6. Diary detail tag — the " · adjusted" suffix is idempotent, strippable,
 *      and survives quantity rescales for both detail formats.
 *   7. Meal-slot preselection — the clock→slot band table (shared with the
 *      server's meal-slot module), "HH:MM" formatting, and the preview
 *      default: the card's slot first, the device clock only when the card
 *      has none.
 *   8. Ounce options everywhere — fl oz joins the volume family; measure
 *      data (data/ingredient-measures.ts) gives solids a weight-oz bridge
 *      (ozPerCup / ozPerPiece) and liquids fl oz; unit round-trips snap back
 *      to the exact original; ounce adjustments survive sanitize → JSON →
 *      reopen; and EVERY editable curated row offers exactly one ounce unit.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:recipe-nutrition
 */
import {
  adjustedPerServing,
  amountBounds,
  applyAdjustments,
  clampAmount,
  conversionFactor,
  conversionFactorFor,
  convertAmountToUnit,
  formatIngredientAmount,
  roundNutrition,
  sameAdjustments,
  sameUnit,
  sanitizeAdjustments,
  scaleFactorFromOriginal,
  stepForUnit,
  totalsForQuantity,
  unitOptions,
} from '../data/ingredient-nutrition';
import { measureForIngredient } from '../data/ingredient-measures';
import { RECIPES, type IngredientAdjustment, type RecipeIngredient } from '../data/patient-data';
import { parseRecipeCardPayload } from '../lib/ai-recipe';
import { localTimeForDate, mealSlotForDate, previewMealSlot } from '../lib/meal-slot';
import {
  ADJUSTED_TAG_SUFFIX,
  rescaleEntrySnapshot,
  stripAdjustedTag,
  withAdjustedTag,
} from '../data/diary-entries';
import type { MealLogEntry } from '../data/patient-data';

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

function assertEqual(label: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(label: string, actual: number, expected: number, eps = 1e-9) {
  checks += 1;
  if (!(Math.abs(actual - expected) <= eps)) {
    fail(`${label}: expected ~${expected}, got ${actual}`);
  }
}

// ── 1. Curated catalog: exact integer decomposition of every recipe ─────────
{
  const offenders: string[] = [];
  for (const recipe of RECIPES) {
    const sums = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    recipe.ingredients.forEach((ingredient, index) => {
      if (ingredient.amount > 0) {
        if (!ingredient.nutrition) {
          offenders.push(`${recipe.id}[${index}] has amount but no nutrition`);
          return;
        }
        const values = Object.values(ingredient.nutrition);
        if (!values.every(v => Number.isInteger(v) && v >= 0)) {
          offenders.push(`${recipe.id}[${index}] has non-integer/negative nutrition`);
        }
        sums.calories += ingredient.nutrition.calories;
        sums.protein += ingredient.nutrition.protein;
        sums.carbs += ingredient.nutrition.carbs;
        sums.fat += ingredient.nutrition.fat;
      } else if (ingredient.nutrition) {
        offenders.push(`${recipe.id}[${index}] is "to taste" but carries nutrition`);
      }
    });
    if (
      sums.calories !== recipe.calories ||
      sums.protein !== recipe.protein ||
      sums.carbs !== recipe.carbs ||
      sums.fat !== recipe.fat
    ) {
      offenders.push(
        `${recipe.id} sums ${JSON.stringify(sums)} != totals ${recipe.calories}/${recipe.protein}/${recipe.carbs}/${recipe.fat}`,
      );
    }
  }
  assert(
    `all ${RECIPES.length} curated recipes decompose exactly per macro` +
      (offenders.length > 0 ? ` — offenders: ${offenders.slice(0, 3).join('; ')}` : ''),
    offenders.length === 0,
  );
  assert('catalog is non-trivial (20 recipes)', RECIPES.length === 20);
}

// ── 2. Unit families and conversion factors ─────────────────────────────────
assertClose('oz→lb', conversionFactor('oz', 'lb')!, 1 / 16);
assertClose('lb→oz', conversionFactor('lb', 'oz')!, 16);
assertClose('tbsp→tsp', conversionFactor('tbsp', 'tsp')!, 3);
assertClose('cup→tbsp', conversionFactor('cup', 'tbsp')!, 16);
assertClose('cups→cup (display spelling)', conversionFactor('cups', 'cup')!, 1);
assertEqual('oz→cup crosses families', conversionFactor('oz', 'cup'), null);
assertEqual('pieces have no family', conversionFactor('pieces', 'oz'), null);
assertEqual('countable "" has no family', conversionFactor('', 'oz'), null);
assertEqual('oz options', unitOptions('oz'), ['oz', 'lb']);
assertEqual('cups options keep original spelling', unitOptions('cups'), ['tsp', 'tbsp', 'cups']);
assertEqual('pieces options are fixed', unitOptions('pieces'), ['pieces']);
assertEqual('step tsp', stepForUnit('tsp'), 0.25);
assertEqual('step lb', stepForUnit('lb'), 0.25);
assertEqual('step oz', stepForUnit('oz'), 0.5);
assertEqual('step countable', stepForUnit(''), 0.5);

// ── 3. Scale factors always derive from the ORIGINAL baseline ───────────────
{
  const original = { amount: 6, unit: 'oz' };
  assertClose('6oz→3oz is 0.5', scaleFactorFromOriginal(original, { amount: 3, unit: 'oz' })!, 0.5);
  assertClose('6oz→0.375lb is 1 (unit switch only)', scaleFactorFromOriginal(original, { amount: 0.375, unit: 'lb' })!, 1);
  assertClose('6oz→0.5lb is 8/6', scaleFactorFromOriginal(original, { amount: 0.5, unit: 'lb' })!, 8 / 6);
  assertEqual('to-taste baseline is null', scaleFactorFromOriginal({ amount: 0, unit: '' }, { amount: 1, unit: '' }), null);
  assertEqual('cross-family is null', scaleFactorFromOriginal(original, { amount: 1, unit: 'cup' }), null);

  const salmon: RecipeIngredient[] = [
    { amount: 6, unit: 'oz', name: 'salmon', nutrition: { calories: 230, protein: 25, carbs: 0, fat: 14 } },
  ];
  // Direct set vs. re-edit history: identical adjustment list output, so the
  // rescaled nutrition is bit-identical — nothing compounds.
  const direct = applyAdjustments(salmon, [{ index: 0, amount: 2.5, unit: 'oz' }]);
  const reEdited = applyAdjustments(salmon, [
    { index: 0, amount: 3, unit: 'oz' },
    { index: 0, amount: 2.5, unit: 'oz' },
  ]);
  assertEqual('no compounding: direct == re-edited', direct[0].nutrition, reEdited[0].nutrition);
  assertClose('2.5oz calories', direct[0].nutrition!.calories, 230 * (2.5 / 6));
  // lb round trip: 0.375 lb IS 6 oz — nutrition must be exactly the original.
  const lbSwitch = applyAdjustments(salmon, [{ index: 0, amount: 0.375, unit: 'lb' }]);
  assertEqual('0.375lb == 6oz exactly', lbSwitch[0].nutrition, salmon[0].nutrition);
  assert('unit switch marks the row adjusted', lbSwitch[0].adjusted);
  // Damaged persisted adjustment (bad unit) degrades to unchanged, not NaN.
  const damaged = applyAdjustments(salmon, [{ index: 0, amount: 2, unit: 'cup' }]);
  assert('incompatible unit degrades to unchanged', !damaged[0].adjusted);
  assertEqual('degraded row keeps original nutrition', damaged[0].nutrition, salmon[0].nutrition);
}

// ── 4. Adjusted per-serving totals (delta method) ────────────────────────────
{
  // Any curated recipe whose lead ingredient carries calories works here.
  const target = RECIPES.find(r => (r.ingredients[0]?.nutrition?.calories ?? 0) > 0)!;
  const first = target.ingredients[0];
  const base = { calories: target.calories, protein: target.protein, carbs: target.carbs, fat: target.fat };
  assertEqual('unadjusted totals are EXACTLY the stated values', adjustedPerServing(base, target.ingredients, []), base);

  // Halve the lead ingredient: totals shift by −half its contribution.
  const firstN = first.nutrition!;
  const halved = adjustedPerServing(base, target.ingredients, [
    { index: 0, amount: first.amount / 2, unit: first.unit },
  ]);
  assertClose('halved lead-ingredient calories', halved.calories, target.calories - firstN.calories / 2);
  assertClose('halved lead-ingredient protein', halved.protein, target.protein - firstN.protein / 2);
  assertClose('halved lead-ingredient fat', halved.fat, target.fat - firstN.fat / 2);

  // Rounded once at the boundary; ×quantity for the diary entry.
  const logged = totalsForQuantity(halved, 2);
  assertEqual('log totals round once', logged.calories, Math.round(halved.calories * 2));

  // Deltas can never push a macro below zero.
  const tinyBase = { calories: 10, protein: 1, carbs: 1, fat: 1 };
  const bigIngredient: RecipeIngredient[] = [
    { amount: 4, unit: 'oz', name: 'x', nutrition: { calories: 100, protein: 10, carbs: 10, fat: 10 } },
  ];
  const clamped = adjustedPerServing(tinyBase, bigIngredient, [{ index: 0, amount: 0.5, unit: 'oz' }]);
  assert('clamped at zero', clamped.calories === 0 && clamped.protein === 0);

  // roundNutrition is display-only whole numbers.
  assertEqual('roundNutrition', roundNutrition({ calories: 10.6, protein: 1.2, carbs: 0.5, fat: 2.49 }), {
    calories: 11, protein: 1, carbs: 1, fat: 2,
  });
}

// ── 5. sanitizeAdjustments + bounds ──────────────────────────────────────────
{
  const ingredients: RecipeIngredient[] = [
    { amount: 6, unit: 'oz', name: 'salmon', nutrition: { calories: 230, protein: 25, carbs: 0, fat: 14 } },
    { amount: 1, unit: 'tsp', name: 'oil', nutrition: { calories: 40, protein: 0, carbs: 0, fat: 5 } },
    { amount: 0, unit: '', name: 'salt' },
  ];
  const cleaned = sanitizeAdjustments(ingredients, [
    { index: 7, amount: 2, unit: 'oz' }, // out of range
    { index: 2, amount: 1, unit: '' }, // to-taste row: not adjustable
    { index: 0, amount: -3, unit: 'oz' }, // non-positive
    { index: 0, amount: 2, unit: 'cup' }, // incompatible unit
    { index: 1, amount: 2, unit: 'tsp' }, // valid…
    { index: 1, amount: 3, unit: 'tsp' }, // …deduped, last wins
    { index: 0, amount: 3, unit: 'oz' }, // valid; sorts before index 1
  ]);
  assertEqual('sanitize keeps only valid entries, deduped + sorted', cleaned, [
    { index: 0, amount: 3, unit: 'oz' },
    { index: 1, amount: 3, unit: 'tsp' },
  ]);

  // Return-to-original deletes earlier writes instead of storing a no-op.
  const backToOriginal = sanitizeAdjustments(ingredients, [
    { index: 0, amount: 3, unit: 'oz' },
    { index: 0, amount: 6, unit: 'oz' },
  ]);
  assertEqual('return-to-original clears the row', backToOriginal, []);

  // Clamping: 8× the original is the ceiling, 0 is the floor (ingredient can be skipped).
  const bounds = amountBounds({ amount: 6, unit: 'oz' }, 'oz');
  assertEqual('bounds for 6oz', bounds, { min: 0, max: 48, step: 0.5 });
  assertEqual('clamp high', clampAmount(500, { amount: 6, unit: 'oz' }, 'oz'), 48);
  assertEqual('clamp to zero', clampAmount(0, { amount: 6, unit: 'oz' }, 'oz'), 0);
  assertEqual('clamp negative to zero', clampAmount(-1, { amount: 6, unit: 'oz' }, 'oz'), 0);
  const clampedList = sanitizeAdjustments(ingredients, [{ index: 0, amount: 500, unit: 'oz' }]);
  assertEqual('sanitize clamps amounts into bounds', clampedList, [{ index: 0, amount: 48, unit: 'oz' }]);

  const a: IngredientAdjustment[] = [{ index: 0, amount: 3, unit: 'oz' }];
  assert('sameAdjustments equal lists', sameAdjustments(a, [{ index: 0, amount: 3, unit: 'oz' }]));
  assert('sameAdjustments differing amount', !sameAdjustments(a, [{ index: 0, amount: 3.5, unit: 'oz' }]));
  assert('sameAdjustments differing length', !sameAdjustments(a, []));
}

// ── 6. AI card payload: lenient per-ingredient nutrition parsing ────────────
{
  const payload = (ingredients: unknown[]) => ({
    id: 'sugg_test_1',
    mode: 'recipe',
    name: 'Test Salmon',
    description: 'A test dish.',
    meal: 'dinner',
    minutes: 20,
    servings: 1,
    calories: 420,
    protein: 38,
    carbs: 18,
    fat: 22,
    ingredients,
    steps: ['Cook it.'],
  });

  const good = parseRecipeCardPayload(
    payload([
      { amount: 6, unit: 'oz', name: 'salmon', nutrition: { calories: 230, protein: 25, carbs: 0, fat: 14 } },
      { amount: 2, unit: 'cups', name: 'broccoli', nutrition: { calories: 190, protein: 13, carbs: 18, fat: 8 } },
    ]),
  );
  assert('well-formed payload parses', good !== null);
  assertEqual('nutrition survives parsing', good!.ingredients[0].nutrition, {
    calories: 230, protein: 25, carbs: 0, fat: 14,
  });

  const malformedCases: [string, unknown][] = [
    ['missing field', { calories: 230, protein: 25, carbs: 0 }],
    ['negative value', { calories: -5, protein: 25, carbs: 0, fat: 14 }],
    ['non-numeric', { calories: 'high', protein: 25, carbs: 0, fat: 14 }],
    ['non-object', 'lots'],
  ];
  for (const [label, nutrition] of malformedCases) {
    const parsed = parseRecipeCardPayload(payload([{ amount: 6, unit: 'oz', name: 'salmon', nutrition }]));
    assert(`${label}: card still parses`, parsed !== null);
    assert(`${label}: bad nutrition dropped, row kept`, parsed !== null && parsed.ingredients[0].nutrition === undefined && parsed.ingredients[0].name === 'salmon');
  }
  const bare = parseRecipeCardPayload(payload([{ amount: 6, unit: 'oz', name: 'salmon' }]));
  assert('nutrition-free ingredient parses (older cards)', bare !== null && bare.ingredients[0].nutrition === undefined);
}

// ── 7. The " · adjusted" diary tag ───────────────────────────────────────────
{
  assertEqual('tag appends', withAdjustedTag('1 serving · recipe'), `1 serving · recipe${ADJUSTED_TAG_SUFFIX}`);
  assertEqual('tag is idempotent', withAdjustedTag(withAdjustedTag('1 serving · recipe')), `1 serving · recipe${ADJUSTED_TAG_SUFFIX}`);
  assertEqual('strip removes', stripAdjustedTag(`1 serving · recipe${ADJUSTED_TAG_SUFFIX}`), '1 serving · recipe');
  assertEqual('strip is safe on untagged', stripAdjustedTag('1 serving · recipe'), '1 serving · recipe');

  const tagged: MealLogEntry = {
    id: 'log_t1', dateKey: '2026-08-01', meal: 'dinner', kind: 'recipe', refId: 'baked_salmon',
    name: 'Baked Salmon Dish', detail: `1 serving · recipe${ADJUSTED_TAG_SUFFIX}`,
    quantity: 1, calories: 380, protein: 33, carbs: 10, fat: 22,
  };
  assertEqual('tag survives serving rescale', rescaleEntrySnapshot(tagged, 2).detail, `2 servings · recipe${ADJUSTED_TAG_SUFFIX}`);
  const taggedFood: MealLogEntry = { ...tagged, kind: 'food', detail: `4 oz${ADJUSTED_TAG_SUFFIX}` };
  assertEqual('tag survives × rescale', rescaleEntrySnapshot(taggedFood, 2).detail, `2 × 4 oz${ADJUSTED_TAG_SUFFIX}`);
}

// ── 8. Amount formatting ─────────────────────────────────────────────────────
assertEqual('integer', formatIngredientAmount(6), '6');
assertEqual('half glyph', formatIngredientAmount(0.5), '½');
assertEqual('quarter glyph', formatIngredientAmount(0.25), '¼');
assertEqual('three-quarter glyph', formatIngredientAmount(0.75), '¾');
assertEqual('one-decimal', formatIngredientAmount(1.5), '1.5');
assertEqual('lb conversion result', formatIngredientAmount(0.375), '0.375');
assertEqual('trims long decimals', formatIngredientAmount(1 / 3), '0.333');

// ── 9. Meal-slot preselection (fixed dates — never the real clock) ───────────
{
  const at = (hours: number, minutes: number) => new Date(2026, 7, 26, hours, minutes, 0);

  // Band table, boundaries included; mirrors the server's meal-slot module
  // (artifacts/api-server/src/coach/meal-slot.ts) — keep the two in step.
  const bands: Array<[number, number, string]> = [
    [4, 0, 'breakfast'], [8, 0, 'breakfast'], [10, 59, 'breakfast'],
    [11, 0, 'lunch'], [14, 0, 'lunch'], [14, 59, 'lunch'],
    [15, 0, 'snacks'], [16, 59, 'snacks'],
    [17, 0, 'dinner'], [19, 0, 'dinner'], [21, 59, 'dinner'],
    [22, 0, 'snacks'], [23, 30, 'snacks'], [0, 0, 'snacks'], [3, 59, 'snacks'],
  ];
  for (const [h, m, slot] of bands) {
    assertEqual(`clock ${h}:${m} maps to ${slot}`, mealSlotForDate(at(h, m)), slot);
  }

  assertEqual('localTime zero-pads hours and minutes', localTimeForDate(at(9, 5)), '09:05');
  assertEqual('localTime keeps 24-hour form', localTimeForDate(at(14, 5)), '14:05');
  assertEqual('midnight reads 00:00', localTimeForDate(at(0, 0)), '00:00');

  // Preview preselection: the card's own slot wins (the server already
  // resolved an explicit pin, the patient's words, or their local time into
  // it); only a slotless card falls back to the device clock — replacing
  // the old hardcoded Snacks default.
  assertEqual('a card slot beats the clock ("for dinner" at 2 pm)', previewMealSlot('dinner', at(14, 0)), 'dinner');
  assertEqual('a slotless card at 2 pm preselects lunch', previewMealSlot(undefined, at(14, 0)), 'lunch');
  assertEqual('a slotless card at 8 am preselects breakfast', previewMealSlot(undefined, at(8, 0)), 'breakfast');
  assertEqual('a slotless card late evening preselects snacks', previewMealSlot(undefined, at(22, 30)), 'snacks');
}

// ── 10. fl oz: a real volume unit with exact factors and aliases ────────────
assertClose('cup→fl oz', conversionFactor('cup', 'fl oz')!, 8);
assertClose('fl oz→tbsp', conversionFactor('fl oz', 'tbsp')!, 2);
assertClose('tsp→fl oz', conversionFactor('tsp', 'fl oz')!, 1 / 6);
assertClose('floz alias', conversionFactor('floz', 'fl oz')!, 1);
assertClose('Fluid Ounces alias', conversionFactor('Fluid Ounces', 'tbsp')!, 2);
assertEqual('fl oz never crosses to weight without measure data', conversionFactor('fl oz', 'oz'), null);
assertEqual('step fl oz', stepForUnit('fl oz'), 0.5);
assertEqual('fl oz rows offer the volume family', unitOptions('fl oz'), ['tsp', 'tbsp', 'fl oz', 'cup']);
assert('sameUnit collapses spellings', sameUnit('floz', 'FL OZ') && sameUnit('cups', 'cup') && !sameUnit('oz', 'fl oz'));

// ── 11. Measure matching: liquids, solids, head nouns, exact rows ───────────
{
  assert('almond milk is liquid', measureForIngredient('unsweetened almond milk')?.liquid === true);
  assert('olive oil is liquid', measureForIngredient('olive oil')?.liquid === true);
  assert('soy sauce is liquid', measureForIngredient('low-sodium soy sauce')?.liquid === true);
  assert('lemon juice is liquid (head noun)', measureForIngredient('lemon juice')?.liquid === true);
  assert('chocolate milk is liquid (head noun)', measureForIngredient('chocolate milk')?.liquid === true);
  const milkChocolate = measureForIngredient('milk chocolate chips');
  assert('milk chocolate is a solid (head noun)', !!milkChocolate && !milkChocolate.liquid && milkChocolate.ozPerCup === 6.0);
  assert('rice vinegar is liquid (head noun)', measureForIngredient('rice vinegar')?.liquid === true);
  const sourCream = measureForIngredient('sour cream');
  assert('sour cream overrides liquid cream', !!sourCream && !sourCream.liquid && sourCream.ozPerCup === 8.5);
  assert('heavy cream stays liquid', measureForIngredient('heavy cream')?.liquid === true);
  const bakingSoda = measureForIngredient('baking soda');
  assert('baking soda is not the drink', !!bakingSoda && !bakingSoda.liquid && bakingSoda.ozPerCup === 9.7);

  assertEqual('yogurt density', measureForIngredient('nonfat Greek yogurt')?.ozPerCup, 8.6);
  assertEqual('plural/singular stemming meets', measureForIngredient('blueberry')?.ozPerCup, measureForIngredient('blueberries')?.ozPerCup);
  assertEqual('chia seeds match chia, not a generic "seeds"', measureForIngredient('chia seeds')?.ozPerCup, 6.8);
  assertEqual('sliced almonds beat almonds', measureForIngredient('sliced almonds')?.ozPerCup, 3.2);
  assertEqual('egg whites beat egg', measureForIngredient('egg whites')?.ozPerPiece, 1.2);
  assertEqual('bagel seasoning is the seasoning, not the bagel', measureForIngredient('everything bagel seasoning')?.ozPerCup, 5.1);
  assertEqual('lemon, juiced is the fruit, not the juice', measureForIngredient('lemon, juiced')?.ozPerPiece, 2.1);

  assertEqual('exact row: canned diced tomatoes weigh the can', measureForIngredient('diced tomatoes (14 oz)')?.ozPerPiece, 14);
  const tuna = measureForIngredient('tuna in water (5 oz), drained');
  assert('exact row: tuna can is 5 oz and not "water"-liquid', !!tuna && !tuna.liquid && tuna.ozPerPiece === 5);
  const cannedTuna = measureForIngredient('canned tuna in oil');
  assert('packing medium is stripped ("in oil" is not the food)', !!cannedTuna && !cannedTuna.liquid);
  assertEqual('exact row: rinsed quinoa is DRY weight', measureForIngredient('quinoa, rinsed')?.ozPerCup, 6.0);
  assertEqual('cooked quinoa keyword stays cooked weight', measureForIngredient('cooked quinoa')?.ozPerCup, 6.5);

  assertEqual('unrecognized names have no measure', measureForIngredient('starfruit compote'), null);
}

// ── 12. Ounce options and conversions per ingredient kind ───────────────────
{
  // Liquids: fl oz slots in before cup; no weight bridge exists.
  assertEqual('liquid cup row options', unitOptions('cup', 'unsweetened almond milk'), ['tsp', 'tbsp', 'fl oz', 'cup']);
  assertEqual('liquid tsp row options', unitOptions('tsp', 'honey'), ['tsp', 'tbsp', 'fl oz', 'cup']);
  assertEqual('liquid tbsp row options', unitOptions('tbsp', 'olive oil'), ['tsp', 'tbsp', 'fl oz', 'cup']);
  assertEqual('liquids never bridge to weight oz', conversionFactorFor('unsweetened almond milk', 'cup', 'oz'), null);
  assertClose('liquid pure volume conversion still applies', conversionFactorFor('unsweetened almond milk', 'cup', 'fl oz')!, 8);

  // Solids by volume: weight oz appends via ozPerCup.
  assertEqual('solid cup row options', unitOptions('cup', 'nonfat Greek yogurt'), ['tsp', 'tbsp', 'cup', 'oz']);
  assertEqual('solid row keeps original spelling', unitOptions('cups', 'baby spinach'), ['tsp', 'tbsp', 'cups', 'oz']);
  assertClose('yogurt cup→oz', conversionFactorFor('nonfat Greek yogurt', 'cup', 'oz')!, 8.6);
  assertClose('yogurt oz→cup', conversionFactorFor('nonfat Greek yogurt', 'oz', 'cup')!, 1 / 8.6);
  assertClose('yogurt tbsp→oz', conversionFactorFor('nonfat Greek yogurt', 'tbsp', 'oz')!, 8.6 * 3 / 48);
  assertClose('yogurt lb→cup crosses through oz', conversionFactorFor('nonfat Greek yogurt', 'lb', 'cup')!, 16 / 8.6);

  // Count rows: oz via ozPerPiece.
  assertEqual('egg count row options', unitOptions('', 'large egg'), ['', 'oz']);
  assertEqual('scoop row options', unitOptions('scoop', 'chocolate whey protein'), ['scoop', 'oz']);
  assertEqual('clove row options', unitOptions('cloves', 'garlic, minced'), ['cloves', 'oz']);
  assertEqual('slice row options', unitOptions('slice', 'whole grain bread'), ['slice', 'oz']);
  assertEqual('can row options', unitOptions('can', 'tuna in water (5 oz), drained'), ['can', 'oz']);
  assertClose('eggs→oz', conversionFactorFor('large egg', '', 'oz')!, 1.8);
  assertClose('oz→eggs', conversionFactorFor('large egg', 'oz', '')!, 1 / 1.8);
  assertEqual('count↔volume never bridges', conversionFactorFor('garlic, minced', 'cloves', 'cup'), null);

  // Weight rows and unrecognized rows: exactly the old behavior.
  assertEqual('weight rows are untouched by measure data', unitOptions('oz', 'salmon fillet'), ['oz', 'lb']);
  assertEqual('unrecognized volume row unchanged', unitOptions('cup', 'starfruit compote'), ['tsp', 'tbsp', 'cup']);
  assertEqual('unrecognized count row unchanged', unitOptions('', 'mystery bits'), ['']);
  assertEqual('unrecognized names never convert to oz', conversionFactorFor('starfruit compote', 'cup', 'oz'), null);
  assertEqual('nameless calls behave like before', conversionFactorFor(undefined, 'cup', 'oz'), null);
}

// ── 13. Ounce edits: snap round-trips, no drift, persistence ────────────────
{
  const bowl = RECIPES.find(r => r.name === 'Greek Yogurt Protein Bowl')!;
  assert('Greek Yogurt Protein Bowl exists', !!bowl);
  const yogurtIndex = bowl.ingredients.findIndex(i => /yogurt/i.test(i.name));
  const yogurt = bowl.ingredients[yogurtIndex];
  assert('bowl leads with a cup of yogurt', yogurtIndex >= 0 && sameUnit(yogurt.unit, 'cup') && yogurt.amount === 1);

  // Switch to oz: realistic weight, then switch back: EXACTLY the original.
  const inOz = convertAmountToUnit(yogurt.name, yogurt, yogurt, 'oz')!;
  assertClose('1 cup yogurt weighs 8.6 oz', inOz, 8.6);
  const backToCup = convertAmountToUnit(yogurt.name, yogurt, { amount: inOz, unit: 'oz' }, yogurt.unit);
  assertEqual('oz→cup round-trip snaps to the exact original', backToCup, yogurt.amount);
  assertEqual(
    'unit round-trip sanitizes to no adjustments',
    sanitizeAdjustments(bowl.ingredients, [
      { index: yogurtIndex, amount: inOz, unit: 'oz' },
      { index: yogurtIndex, amount: backToCup!, unit: yogurt.unit },
    ]),
    [],
  );

  // Ounce amounts drive nutrition from the ORIGINAL cup baseline — no drift.
  const halfInOz = convertAmountToUnit(
    yogurt.name, yogurt, { amount: yogurt.amount / 2, unit: yogurt.unit }, 'oz',
  )!;
  assertClose('half a cup of yogurt in oz', halfInOz, 4.3);
  const halved = applyAdjustments(bowl.ingredients, [{ index: yogurtIndex, amount: halfInOz, unit: 'oz' }])[yogurtIndex];
  assert('oz adjustment marks the row adjusted', halved.adjusted);
  assertClose('4.3 oz halves the calories', halved.nutrition!.calories, yogurt.nutrition!.calories / 2, 1e-6);
  assertClose('…and the protein', halved.nutrition!.protein, yogurt.nutrition!.protein / 2, 1e-6);
  const bowlBase = { calories: bowl.calories, protein: bowl.protein, carbs: bowl.carbs, fat: bowl.fat };
  assertClose(
    'recipe totals shift by exactly the yogurt delta',
    adjustedPerServing(bowlBase, bowl.ingredients, [{ index: yogurtIndex, amount: halfInOz, unit: 'oz' }]).calories,
    bowl.calories - yogurt.nutrition!.calories / 2,
    1e-6,
  );

  // Stepping in oz and settling equals a direct set — bit-identical nutrition.
  const stepped = sanitizeAdjustments(bowl.ingredients, [
    { index: yogurtIndex, amount: inOz, unit: 'oz' },
    { index: yogurtIndex, amount: 6.5, unit: 'oz' },
    { index: yogurtIndex, amount: halfInOz, unit: 'oz' },
  ]);
  const direct = sanitizeAdjustments(bowl.ingredients, [{ index: yogurtIndex, amount: halfInOz, unit: 'oz' }]);
  assert('editing through oz equals a direct oz set', sameAdjustments(stepped, direct));
  assertEqual(
    'stepped and direct nutrition are bit-identical',
    applyAdjustments(bowl.ingredients, stepped)[yogurtIndex].nutrition,
    applyAdjustments(bowl.ingredients, direct)[yogurtIndex].nutrition,
  );

  // Ounce bounds derive from the converted original (8× ceiling, 0.5 steps).
  assertEqual('yogurt row bounds in oz', amountBounds(yogurt, 'oz', yogurt.name), { min: 0, max: 69, step: 0.5 });
  assertEqual('clamp in oz', clampAmount(500, yogurt, 'oz', yogurt.name), 69);

  // Persistence: sanitize → JSON (log/save) → reopen → identical everywhere.
  const reopened = sanitizeAdjustments(bowl.ingredients, JSON.parse(JSON.stringify(stepped)));
  assert('oz adjustments survive log → reopen', sameAdjustments(reopened, stepped));
  assertEqual(
    'reopened nutrition identical',
    applyAdjustments(bowl.ingredients, reopened)[yogurtIndex].nutrition,
    applyAdjustments(bowl.ingredients, stepped)[yogurtIndex].nutrition,
  );

  // Liquid rows: fl oz round-trips and persists the same way.
  const milkRecipe = RECIPES.find(r => r.ingredients.some(i => i.amount > 0 && !!i.nutrition && /milk/i.test(i.name)))!;
  assert('a curated milk row exists', !!milkRecipe);
  const milkIndex = milkRecipe.ingredients.findIndex(i => i.amount > 0 && !!i.nutrition && /milk/i.test(i.name));
  const milk = milkRecipe.ingredients[milkIndex];
  assert('curated milk is liquid', measureForIngredient(milk.name)?.liquid === true);
  const milkFlOz = convertAmountToUnit(milk.name, milk, milk, 'fl oz')!;
  assertEqual('milk cup→fl oz is exact volume', milkFlOz, milk.amount * conversionFactor(milk.unit, 'fl oz')!);
  assertEqual(
    'fl oz→cup round-trip snaps to the exact original',
    convertAmountToUnit(milk.name, milk, { amount: milkFlOz, unit: 'fl oz' }, milk.unit),
    milk.amount,
  );
  const halfMilk = milkFlOz / 2;
  const savedMilk = sanitizeAdjustments(milkRecipe.ingredients, [{ index: milkIndex, amount: halfMilk, unit: 'fl oz' }]);
  assertEqual('fl oz adjustment survives sanitize', savedMilk, [{ index: milkIndex, amount: halfMilk, unit: 'fl oz' }]);
  const reopenedMilk = sanitizeAdjustments(milkRecipe.ingredients, JSON.parse(JSON.stringify(savedMilk)));
  assert('fl oz adjustment survives log → reopen', sameAdjustments(reopenedMilk, savedMilk));
  const milkBase = { calories: milkRecipe.calories, protein: milkRecipe.protein, carbs: milkRecipe.carbs, fat: milkRecipe.fat };
  assertClose(
    'halved milk shifts totals by half its calories',
    adjustedPerServing(milkBase, milkRecipe.ingredients, reopenedMilk).calories,
    milkRecipe.calories - milk.nutrition!.calories / 2,
    1e-6,
  );

  // Count rows: eggs by weight, and back.
  const eggRecipe = RECIPES.find(r =>
    r.ingredients.some(i => i.amount > 0 && !!i.nutrition && /egg/i.test(i.name) && !/white|yolk/i.test(i.name)),
  )!;
  assert('a curated whole-egg row exists', !!eggRecipe);
  const eggIndex = eggRecipe.ingredients.findIndex(
    i => i.amount > 0 && !!i.nutrition && /egg/i.test(i.name) && !/white|yolk/i.test(i.name),
  );
  const egg = eggRecipe.ingredients[eggIndex];
  const eggsInOz = convertAmountToUnit(egg.name, egg, egg, 'oz')!;
  assertClose('eggs convert at 1.8 oz per egg', eggsInOz, egg.amount * 1.8);
  assertEqual(
    'oz→count round-trip snaps to the exact original',
    convertAmountToUnit(egg.name, egg, { amount: eggsInOz, unit: 'oz' }, egg.unit),
    egg.amount,
  );
  const eggView = applyAdjustments(eggRecipe.ingredients, [{ index: eggIndex, amount: eggsInOz, unit: 'oz' }])[eggIndex];
  assertClose('weighing the eggs leaves calories put', eggView.nutrition!.calories, egg.nutrition!.calories, 1e-6);

  // Unrecognized AI-only ingredients degrade exactly like before.
  const aiRows = [
    { amount: 1, unit: 'cup', name: 'starfruit compote', nutrition: { calories: 90, protein: 1, carbs: 22, fat: 0 } },
  ] as RecipeIngredient[];
  assertEqual('unknown ingredient: oz adjustment refused by sanitize', sanitizeAdjustments(aiRows, [{ index: 0, amount: 3, unit: 'oz' }]), []);
  const aiView = applyAdjustments(aiRows, [{ index: 0, amount: 3, unit: 'oz' }])[0];
  assert('unknown ingredient: raw oz adjustment degrades to unchanged', !aiView.adjusted);
  assertEqual('unknown ingredient keeps original nutrition', aiView.nutrition, aiRows[0].nutrition);

  // Recognized AI liquids get fl oz with exact volume math.
  assertEqual('AI broth row offers fl oz', unitOptions('cups', 'reduced-sodium chicken broth'), ['tsp', 'tbsp', 'fl oz', 'cups']);
  const broth = [
    { amount: 2, unit: 'cups', name: 'reduced-sodium chicken broth', nutrition: { calories: 30, protein: 4, carbs: 2, fat: 0 } },
  ] as RecipeIngredient[];
  const brothView = applyAdjustments(broth, [{ index: 0, amount: 8, unit: 'fl oz' }])[0];
  assertClose('8 fl oz of 2 cups halves the calories', brothView.nutrition!.calories, 15);

  // fl-oz display amounts format cleanly.
  assertEqual('fl oz amounts format cleanly', formatIngredientAmount(1 / 6), '0.167');
  assertEqual('oz amounts format cleanly', formatIngredientAmount(8.6), '8.6');
}

// ── 14. Coverage: every editable curated row offers exactly one ounce unit ──
{
  const missing: string[] = [];
  const dual: string[] = [];
  const broken: string[] = [];
  for (const recipe of RECIPES) {
    recipe.ingredients.forEach((ingredient, index) => {
      if (!(ingredient.amount > 0) || !ingredient.nutrition) return;
      const options = unitOptions(ingredient.unit, ingredient.name);
      const hasOz = options.some(o => sameUnit(o, 'oz'));
      const hasFlOz = options.some(o => sameUnit(o, 'fl oz'));
      const tag = `${recipe.id}[${index}] ${ingredient.name} (${ingredient.unit || 'count'})`;
      if (!hasOz && !hasFlOz) {
        missing.push(tag);
        return;
      }
      if (hasOz && hasFlOz) dual.push(tag);
      const target = hasFlOz ? 'fl oz' : 'oz';
      if (sameUnit(ingredient.unit, target)) return; // already measured in ounces
      const factor = conversionFactorFor(ingredient.name, ingredient.unit, target);
      if (factor === null || !Number.isFinite(factor) || factor <= 0) {
        broken.push(tag);
        return;
      }
      const ounces = ingredient.amount * factor;
      if (!(ounces > 0.005 && ounces < 160)) broken.push(`${tag} → ${ounces} ${target}`);
    });
  }
  assert(
    `every editable curated row offers an ounce option${missing.length > 0 ? ` — missing: ${missing.slice(0, 4).join('; ')}` : ''}`,
    missing.length === 0,
  );
  assert(
    `no row offers both oz and fl oz${dual.length > 0 ? ` — ${dual.slice(0, 4).join('; ')}` : ''}`,
    dual.length === 0,
  );
  assert(
    `every ounce option converts to a realistic amount${broken.length > 0 ? ` — ${broken.slice(0, 4).join('; ')}` : ''}`,
    broken.length === 0,
  );
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ recipe nutrition invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ recipe nutrition invariants: ${checks} checks passed`);
