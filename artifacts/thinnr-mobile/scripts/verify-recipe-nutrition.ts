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
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:recipe-nutrition
 */
import {
  adjustedPerServing,
  amountBounds,
  applyAdjustments,
  clampAmount,
  conversionFactor,
  formatIngredientAmount,
  roundNutrition,
  sameAdjustments,
  sanitizeAdjustments,
  scaleFactorFromOriginal,
  stepForUnit,
  totalsForQuantity,
  unitOptions,
} from '../data/ingredient-nutrition';
import { RECIPES, type IngredientAdjustment, type RecipeIngredient } from '../data/patient-data';
import { parseRecipeCardPayload } from '../lib/ai-recipe';
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

  // Clamping: 8× the original is the ceiling, one step is the floor.
  const bounds = amountBounds({ amount: 6, unit: 'oz' }, 'oz');
  assertEqual('bounds for 6oz', bounds, { min: 0.5, max: 48, step: 0.5 });
  assertEqual('clamp high', clampAmount(500, { amount: 6, unit: 'oz' }, 'oz'), 48);
  assertEqual('clamp low', clampAmount(0.01, { amount: 6, unit: 'oz' }, 'oz'), 0.5);
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

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ recipe nutrition invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ recipe nutrition invariants: ${checks} checks passed`);
