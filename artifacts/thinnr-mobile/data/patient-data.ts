/**
 * Patient-mode data for the THINNR companion experience.
 *
 * The demo patient is Emma Smith (pat_100) — a graduated, maintenance-stage
 * patient from the shared staff dataset. All history is deterministic and
 * derived from the same fixed anchor date as data/mock-data.ts, so the staff
 * and patient views tell one consistent story.
 */
import {
  MOCK_PATIENTS,
  MOCK_PRODUCTS,
  MOCK_PROVIDERS,
  MOCK_SUBSCRIPTIONS,
} from './mock-data';

// ─── Anchor date (same fictional "today" as mock-data.ts) ────────────────────

export const TODAY = new Date('2026-08-22T12:00:00.000Z');

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function subDays(date: Date, days: number): Date {
  return addDays(date, -days);
}

export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const TODAY_KEY = toDateKey(TODAY);

export function formatDateKey(dateKey: string, includeYear = false): string {
  return new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Shift a YYYY-MM-DD key by whole days (UTC-safe). */
export function shiftDateKey(dateKey: string, days: number): string {
  return toDateKey(addDays(new Date(`${dateKey}T12:00:00.000Z`), days));
}

/** Diary-relative label for a day key: "Today", "Yesterday", or the short date. */
export function dayLabel(dateKey: string): string {
  if (dateKey === TODAY_KEY) return 'Today';
  if (dateKey === shiftDateKey(TODAY_KEY, -1)) return 'Yesterday';
  return formatDateKey(dateKey);
}

const seededFraction = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

// ─── Demo patient identity ───────────────────────────────────────────────────

export const PATIENT_ID = 'pat_100';

const profile = MOCK_PATIENTS.find(p => p.id === PATIENT_ID);
if (!profile) throw new Error('Demo patient pat_100 missing from mock data');

export const PATIENT_PROFILE = profile;
export const PATIENT_SUBSCRIPTION = MOCK_SUBSCRIPTIONS.find(s => s.patientId === PATIENT_ID) ?? null;
export const PATIENT_PROVIDER = MOCK_PROVIDERS.find(p => p.id === profile.providerId) ?? null;
export const PATIENT_PRODUCTS = profile.products
  .map(pid => MOCK_PRODUCTS.find(pr => pr.id === pid))
  .filter((p): p is (typeof MOCK_PRODUCTS)[number] => Boolean(p));

const ENROLLMENT_DATE = new Date(PATIENT_PROFILE.startDate);
export const ENROLLMENT_DAYS = Math.round((TODAY.getTime() - ENROLLMENT_DATE.getTime()) / 86_400_000);

// ─── Types ───────────────────────────────────────────────────────────────────

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

export const MEAL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snacks'];

export const MEAL_LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snacks: 'Snacks',
};

export interface FoodItem {
  id: string;
  name: string;
  brand?: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  category: string;
  /** Optional photo (data URI) — set on foods saved from AI suggestions. */
  photoUri?: string;
}

export interface RecipeIngredient {
  amount: number; // 0 means "to taste" — render name only
  unit: string;
  name: string;
}

export interface Recipe {
  id: string;
  name: string;
  meal: MealSlot;
  tags: string[];
  minutes: number;
  servings: number;
  calories: number; // per serving
  protein: number;
  carbs: number;
  fat: number;
  description: string;
  ingredients: RecipeIngredient[];
  steps: string[];
}

/**
 * A coach (AI) suggestion the patient chose to keep. Nutrition numbers are
 * model estimates — screens must label them as such. The generated photo is
 * stored inline as a data URI so it survives restarts with the recipe.
 */
export interface SavedRecipe extends Recipe {
  source: 'coach';
  mode: 'recipe' | 'cravings';
  savedAt: string; // ISO timestamp
  photoUri?: string;
  groceryList?: string[];
}
export interface MealLogEntry {
  id: string;
  dateKey: string;
  meal: MealSlot;
  kind: 'food' | 'recipe' | 'quick';
  refId?: string;
  name: string;
  detail: string;
  quantity: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface CheckIn {
  id: string;
  dateKey: string;
  weight?: number;
  mood: 1 | 2 | 3 | 4 | 5;
  sideEffects: string[];
  notes?: string;
}

export interface ProgressPhoto {
  id: string;
  dateKey: string;
  label: string;
  source: 'seed' | 'user';
  uri?: string;
}

export interface DailyTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterOz: number;
}

export const DEFAULT_TARGETS: DailyTargets = {
  calories: 1500,
  protein: 120,
  carbs: 130,
  fat: 50,
  waterOz: 64,
};

export const WATER_CUP_OZ = 8;

export const MOOD_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Rough',
  2: 'Low',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
};

export const SIDE_EFFECT_OPTIONS = ['Nausea', 'Headache', 'Fatigue', 'Dizziness', 'Constipation'];

// ─── Food database ───────────────────────────────────────────────────────────

function f(
  id: string,
  name: string,
  serving: string,
  calories: number,
  protein: number,
  carbs: number,
  fat: number,
  category: string,
  brand?: string,
): FoodItem {
  return { id, name, serving, calories, protein, carbs, fat, category, brand };
}

export const FOOD_DB: FoodItem[] = [
  // Proteins
  f('fd_chicken_breast', 'Chicken Breast, grilled', '4 oz', 187, 35, 0, 4, 'Proteins'),
  f('fd_ground_turkey', 'Ground Turkey, 93% lean', '4 oz', 170, 22, 0, 9, 'Proteins'),
  f('fd_salmon', 'Salmon, baked', '4 oz', 233, 25, 0, 14, 'Proteins'),
  f('fd_tuna_can', 'Tuna, canned in water', '1 can (5 oz)', 120, 26, 1, 1, 'Proteins'),
  f('fd_shrimp', 'Shrimp, cooked', '4 oz', 112, 24, 0, 1, 'Proteins'),
  f('fd_cod', 'Cod, baked', '4 oz', 93, 20, 0, 1, 'Proteins'),
  f('fd_sirloin', 'Sirloin Steak, lean', '4 oz', 207, 26, 0, 11, 'Proteins'),
  f('fd_egg', 'Egg, large', '1 egg', 72, 6, 0, 5, 'Proteins'),
  f('fd_egg_whites', 'Egg Whites', '3 large', 51, 11, 1, 0, 'Proteins'),
  f('fd_tofu', 'Tofu, firm', '1/2 cup', 94, 10, 2, 6, 'Proteins'),
  f('fd_deli_turkey', 'Turkey Breast, deli sliced', '3 oz', 90, 18, 2, 1, 'Proteins'),
  f('fd_rotisserie', 'Rotisserie Chicken, skinless', '3 oz', 140, 22, 0, 6, 'Proteins'),
  // Dairy & eggs
  f('fd_greek_yogurt', 'Greek Yogurt, nonfat plain', '1 cup', 130, 23, 9, 0, 'Dairy'),
  f('fd_cottage_cheese', 'Cottage Cheese, 2%', '1 cup', 183, 24, 8, 5, 'Dairy'),
  f('fd_cheddar', 'Cheddar Cheese', '1 oz', 114, 7, 1, 9, 'Dairy'),
  f('fd_feta', 'Feta Cheese, crumbled', '1/4 cup', 99, 5, 1, 8, 'Dairy'),
  f('fd_mozzarella', 'Mozzarella, part-skim', '1 oz', 72, 7, 1, 5, 'Dairy'),
  f('fd_skim_milk', 'Milk, skim', '1 cup', 83, 8, 12, 0, 'Dairy'),
  f('fd_almond_milk', 'Almond Milk, unsweetened', '1 cup', 39, 1, 3, 3, 'Dairy'),
  f('fd_string_cheese', 'String Cheese, light', '1 stick', 80, 7, 1, 5, 'Dairy'),
  // Grains & starches
  f('fd_brown_rice', 'Brown Rice, cooked', '1 cup', 216, 5, 45, 2, 'Grains'),
  f('fd_quinoa', 'Quinoa, cooked', '1 cup', 222, 8, 39, 4, 'Grains'),
  f('fd_oats', 'Rolled Oats, dry', '1/2 cup', 150, 5, 27, 3, 'Grains'),
  f('fd_ww_bread', 'Whole Wheat Bread', '1 slice', 81, 4, 14, 1, 'Grains'),
  f('fd_ww_wrap', 'Whole Wheat Wrap', '1 large', 210, 7, 35, 5, 'Grains'),
  f('fd_ww_pasta', 'Whole Wheat Pasta, cooked', '1 cup', 174, 7, 37, 1, 'Grains'),
  f('fd_sweet_potato', 'Sweet Potato, baked', '1 medium', 103, 2, 24, 0, 'Grains'),
  // Fruits
  f('fd_apple', 'Apple', '1 medium', 95, 0, 25, 0, 'Fruits'),
  f('fd_banana', 'Banana', '1 medium', 105, 1, 27, 0, 'Fruits'),
  f('fd_blueberries', 'Blueberries', '1 cup', 84, 1, 21, 0, 'Fruits'),
  f('fd_strawberries', 'Strawberries', '1 cup', 49, 1, 12, 0, 'Fruits'),
  f('fd_raspberries', 'Raspberries', '1 cup', 64, 1, 15, 1, 'Fruits'),
  f('fd_orange', 'Orange', '1 medium', 62, 1, 15, 0, 'Fruits'),
  f('fd_grapes', 'Grapes', '1 cup', 104, 1, 27, 0, 'Fruits'),
  f('fd_watermelon', 'Watermelon, diced', '1 cup', 46, 1, 12, 0, 'Fruits'),
  f('fd_avocado', 'Avocado', '1/2 fruit', 120, 1, 6, 11, 'Fruits'),
  // Vegetables
  f('fd_broccoli', 'Broccoli, steamed', '1 cup', 31, 3, 6, 0, 'Vegetables'),
  f('fd_spinach', 'Spinach, raw', '2 cups', 14, 2, 2, 0, 'Vegetables'),
  f('fd_romaine', 'Romaine Lettuce', '2 cups', 16, 1, 3, 0, 'Vegetables'),
  f('fd_carrots', 'Carrot', '1 medium', 25, 1, 6, 0, 'Vegetables'),
  f('fd_cucumber', 'Cucumber, sliced', '1 cup', 16, 1, 4, 0, 'Vegetables'),
  f('fd_bell_pepper', 'Bell Pepper', '1 medium', 25, 1, 6, 0, 'Vegetables'),
  f('fd_cherry_tomatoes', 'Cherry Tomatoes', '1 cup', 27, 1, 6, 0, 'Vegetables'),
  f('fd_zucchini', 'Zucchini', '1 medium', 33, 2, 6, 1, 'Vegetables'),
  f('fd_asparagus', 'Asparagus', '8 spears', 26, 3, 5, 0, 'Vegetables'),
  f('fd_brussels', 'Brussels Sprouts, roasted', '1 cup', 38, 3, 8, 0, 'Vegetables'),
  f('fd_kale', 'Kale, raw', '2 cups', 17, 1, 3, 0, 'Vegetables'),
  f('fd_cauli_rice', 'Cauliflower Rice', '1 cup', 25, 2, 5, 0, 'Vegetables'),
  // Snacks
  f('fd_almonds', 'Almonds', '1 oz (23 nuts)', 164, 6, 6, 14, 'Snacks'),
  f('fd_walnuts', 'Walnuts', '1 oz', 185, 4, 4, 18, 'Snacks'),
  f('fd_peanut_butter', 'Peanut Butter', '1 tbsp', 96, 4, 3, 8, 'Snacks'),
  f('fd_almond_butter', 'Almond Butter', '1 tbsp', 98, 3, 3, 9, 'Snacks'),
  f('fd_hummus', 'Hummus', '1/4 cup', 104, 5, 9, 6, 'Snacks'),
  f('fd_protein_bar', 'Boost Protein Bar', '1 bar', 190, 20, 22, 5, 'Snacks', 'THINNR'),
  f('fd_rice_cake', 'Rice Cake, plain', '1 cake', 35, 1, 7, 0, 'Snacks'),
  f('fd_dark_chocolate', 'Dark Chocolate, 70%', '1 oz', 170, 2, 13, 12, 'Snacks'),
  f('fd_popcorn', 'Popcorn, air-popped', '3 cups', 93, 3, 19, 1, 'Snacks'),
  f('fd_protein_powder', 'Whey Protein Powder', '1 scoop', 120, 24, 3, 1, 'Snacks'),
  f('fd_trail_mix', 'Trail Mix', '1/4 cup', 173, 5, 17, 11, 'Snacks'),
  // Beverages
  f('fd_coffee', 'Coffee, black', '1 cup', 2, 0, 0, 0, 'Beverages'),
  f('fd_green_tea', 'Green Tea, unsweetened', '1 cup', 2, 0, 0, 0, 'Beverages'),
  f('fd_latte', 'Latte, skim milk', '12 fl oz', 100, 10, 15, 0, 'Beverages'),
  f('fd_oj', 'Orange Juice', '1 cup', 112, 2, 26, 0, 'Beverages'),
  f('fd_kombucha', 'Kombucha', '1 cup', 30, 0, 7, 0, 'Beverages'),
  f('fd_sparkling', 'Sparkling Water', '12 fl oz', 0, 0, 0, 0, 'Beverages'),
  // Fats & condiments
  f('fd_olive_oil', 'Olive Oil', '1 tbsp', 119, 0, 0, 14, 'Fats & Condiments'),
  f('fd_butter', 'Butter', '1 tbsp', 102, 0, 0, 12, 'Fats & Condiments'),
  f('fd_light_mayo', 'Mayonnaise, light', '1 tbsp', 36, 0, 1, 3, 'Fats & Condiments'),
  f('fd_ranch_light', 'Ranch Dressing, light', '2 tbsp', 60, 0, 2, 5, 'Fats & Condiments'),
  f('fd_vinaigrette', 'Balsamic Vinaigrette', '1 tbsp', 45, 0, 1, 4, 'Fats & Condiments'),
  f('fd_honey', 'Honey', '1 tsp', 21, 0, 6, 0, 'Fats & Condiments'),
  f('fd_salsa', 'Salsa', '2 tbsp', 10, 0, 2, 0, 'Fats & Condiments'),
  f('fd_soy_sauce', 'Soy Sauce, low sodium', '1 tbsp', 10, 1, 1, 0, 'Fats & Condiments'),
  // Prepared & restaurant
  f('fd_turkey_sandwich', 'Turkey Sandwich', '1 sandwich', 320, 22, 38, 9, 'Prepared'),
  f('fd_burrito_bowl', 'Chicken Burrito Bowl', '1 bowl', 510, 35, 52, 16, 'Prepared'),
  f('fd_pizza_slice', 'Margherita Pizza', '1 slice', 250, 10, 31, 9, 'Prepared'),
  f('fd_california_roll', 'California Roll', '8 pieces', 255, 9, 38, 7, 'Prepared'),
  f('fd_burger', 'Hamburger with Bun', '1 burger', 430, 25, 34, 21, 'Prepared'),
  f('fd_caesar_side', 'Caesar Side Salad', '1 salad', 180, 5, 9, 14, 'Prepared'),
];

export function findFood(id: string): FoodItem | undefined {
  return FOOD_DB.find(item => item.id === id);
}

// ─── Recipe library ──────────────────────────────────────────────────────────

export const RECIPES: Recipe[] = [
  // Breakfast
  {
    id: 'rec_yogurt_bowl',
    name: 'Greek Yogurt Protein Bowl',
    meal: 'breakfast',
    tags: ['High protein', 'Under 15 min', 'Vegetarian'],
    minutes: 10,
    servings: 1,
    calories: 320, protein: 28, carbs: 34, fat: 9,
    description: 'A five-minute protein anchor for protocol mornings — thick nonfat Greek yogurt under a crunch of almonds and two kinds of berries.',
    ingredients: [
      { amount: 1, unit: 'cup', name: 'nonfat Greek yogurt' },
      { amount: 0.5, unit: 'cup', name: 'blueberries' },
      { amount: 0.25, unit: 'cup', name: 'raspberries' },
      { amount: 2, unit: 'tbsp', name: 'sliced almonds' },
      { amount: 1, unit: 'tsp', name: 'honey' },
      { amount: 0.25, unit: 'tsp', name: 'ground cinnamon' },
    ],
    steps: [
      'Spoon the yogurt into a chilled bowl and smooth the surface.',
      'Scatter the blueberries and raspberries over the top.',
      'Sprinkle on the almonds and cinnamon.',
      'Finish with a thin drizzle of honey and serve immediately.',
    ],
  },
  {
    id: 'rec_egg_scramble',
    name: 'Spinach & Egg White Scramble',
    meal: 'breakfast',
    tags: ['High protein', 'Low carb', 'Under 15 min'],
    minutes: 12,
    servings: 1,
    calories: 210, protein: 26, carbs: 6, fat: 9,
    description: 'Soft-scrambled egg whites folded with wilted spinach and blistered cherry tomatoes. Big volume, tiny calorie cost.',
    ingredients: [
      { amount: 6, unit: '', name: 'egg whites' },
      { amount: 2, unit: 'cups', name: 'baby spinach' },
      { amount: 0.5, unit: 'cup', name: 'cherry tomatoes, halved' },
      { amount: 1, unit: 'tsp', name: 'olive oil' },
      { amount: 0, unit: '', name: 'Salt and black pepper, to taste' },
    ],
    steps: [
      'Warm the olive oil in a nonstick skillet over medium heat.',
      'Add the tomatoes and cook 2 minutes until they begin to blister.',
      'Add the spinach and stir until just wilted.',
      'Pour in the egg whites and fold gently until softly set, about 2 minutes.',
      'Season and slide onto a warm plate.',
    ],
  },
  {
    id: 'rec_overnight_oats',
    name: 'Blueberry Overnight Oats',
    meal: 'breakfast',
    tags: ['Meal prep', 'Vegetarian', 'Fiber'],
    minutes: 5,
    servings: 1,
    calories: 340, protein: 18, carbs: 52, fat: 8,
    description: 'Assembled the night before, ready when you wake — oats and chia soaked in almond milk with a Greek yogurt boost.',
    ingredients: [
      { amount: 0.5, unit: 'cup', name: 'rolled oats' },
      { amount: 1, unit: 'tbsp', name: 'chia seeds' },
      { amount: 0.75, unit: 'cup', name: 'unsweetened almond milk' },
      { amount: 0.25, unit: 'cup', name: 'nonfat Greek yogurt' },
      { amount: 0.5, unit: 'cup', name: 'blueberries' },
      { amount: 0.5, unit: 'tsp', name: 'vanilla extract' },
    ],
    steps: [
      'Stir the oats, chia seeds, almond milk, yogurt, and vanilla together in a jar.',
      'Seal and refrigerate at least 6 hours or overnight.',
      'In the morning, stir once and loosen with a splash of almond milk if needed.',
      'Top with blueberries and eat cold.',
    ],
  },
  {
    id: 'rec_avocado_toast',
    name: 'Avocado Toast with Poached Egg',
    meal: 'breakfast',
    tags: ['Vegetarian', 'Under 15 min'],
    minutes: 12,
    servings: 1,
    calories: 310, protein: 14, carbs: 28, fat: 16,
    description: 'The classic, kept honest: one slice of hearty whole grain, half an avocado, and a runny poached egg.',
    ingredients: [
      { amount: 1, unit: 'slice', name: 'whole grain bread' },
      { amount: 0.5, unit: '', name: 'ripe avocado' },
      { amount: 1, unit: '', name: 'large egg' },
      { amount: 1, unit: 'tsp', name: 'lemon juice' },
      { amount: 0.25, unit: 'tsp', name: 'chili flakes' },
      { amount: 0, unit: '', name: 'Flaky salt, to taste' },
    ],
    steps: [
      'Bring a small pot of water to a gentle simmer and toast the bread.',
      'Mash the avocado with lemon juice and a pinch of salt; spread over the toast.',
      'Swirl the simmering water and poach the egg for 3 minutes.',
      'Lift the egg onto the toast, then finish with chili flakes.',
    ],
  },
  {
    id: 'rec_cottage_parfait',
    name: 'Cottage Cheese Berry Parfait',
    meal: 'breakfast',
    tags: ['High protein', 'Under 15 min', 'Vegetarian'],
    minutes: 5,
    servings: 1,
    calories: 250, protein: 24, carbs: 20, fat: 8,
    description: 'Layered like dessert, built like a protein shake — cottage cheese, strawberries, and toasted walnuts.',
    ingredients: [
      { amount: 1, unit: 'cup', name: '2% cottage cheese' },
      { amount: 0.75, unit: 'cup', name: 'strawberries, sliced' },
      { amount: 2, unit: 'tbsp', name: 'chopped walnuts' },
      { amount: 1, unit: 'tsp', name: 'honey' },
    ],
    steps: [
      'Layer half the cottage cheese into a glass, then half the strawberries.',
      'Repeat the layers with the remaining cottage cheese and berries.',
      'Top with walnuts and a drizzle of honey.',
    ],
  },
  // Lunch
  {
    id: 'rec_cobb_salad',
    name: 'Grilled Chicken Cobb Salad',
    meal: 'lunch',
    tags: ['High protein', 'Low carb'],
    minutes: 25,
    servings: 1,
    calories: 420, protein: 40, carbs: 12, fat: 24,
    description: 'A composed salad that eats like a full meal — grilled chicken, egg, avocado, and feta over crisp romaine.',
    ingredients: [
      { amount: 5, unit: 'oz', name: 'chicken breast' },
      { amount: 3, unit: 'cups', name: 'romaine, chopped' },
      { amount: 1, unit: '', name: 'hard-boiled egg, halved' },
      { amount: 0.5, unit: '', name: 'avocado, sliced' },
      { amount: 0.5, unit: 'cup', name: 'cherry tomatoes, halved' },
      { amount: 2, unit: 'tbsp', name: 'crumbled feta' },
      { amount: 1, unit: 'tbsp', name: 'balsamic vinaigrette' },
    ],
    steps: [
      'Season the chicken and grill 5–6 minutes per side until cooked through; rest, then slice.',
      'Spread the romaine over a wide plate.',
      'Arrange the chicken, egg, avocado, tomatoes, and feta in neat rows.',
      'Drizzle with vinaigrette just before eating.',
    ],
  },
  {
    id: 'rec_quinoa_bowl',
    name: 'Turkey & Quinoa Power Bowl',
    meal: 'lunch',
    tags: ['High protein', 'Meal prep'],
    minutes: 30,
    servings: 2,
    calories: 460, protein: 35, carbs: 48, fat: 13,
    description: 'A make-ahead bowl with roast turkey, fluffy quinoa, caramelized sweet potato, and massaged kale.',
    ingredients: [
      { amount: 1, unit: 'cup', name: 'quinoa, rinsed' },
      { amount: 8, unit: 'oz', name: 'roast turkey breast, sliced' },
      { amount: 1, unit: '', name: 'large sweet potato, cubed' },
      { amount: 3, unit: 'cups', name: 'kale, stemmed and torn' },
      { amount: 1, unit: 'tbsp', name: 'olive oil' },
      { amount: 0.5, unit: '', name: 'lemon, juiced' },
      { amount: 0, unit: '', name: 'Salt and pepper, to taste' },
    ],
    steps: [
      'Roast the sweet potato cubes with half the olive oil at 425°F for 22 minutes.',
      'Meanwhile, simmer the quinoa in 2 cups of water for 15 minutes; fluff with a fork.',
      'Massage the kale with the remaining oil and lemon juice until it softens.',
      'Divide quinoa between bowls and top with turkey, sweet potato, and kale.',
    ],
  },
  {
    id: 'rec_tuna_wrap',
    name: 'Mediterranean Tuna Wrap',
    meal: 'lunch',
    tags: ['Under 15 min', 'Pescatarian'],
    minutes: 10,
    servings: 1,
    calories: 380, protein: 32, carbs: 36, fat: 12,
    description: 'Tuna salad rebuilt with Greek yogurt, briny olives, and crunchy cucumber, rolled in a whole wheat wrap.',
    ingredients: [
      { amount: 1, unit: 'can', name: 'tuna in water (5 oz), drained' },
      { amount: 1, unit: '', name: 'large whole wheat wrap' },
      { amount: 2, unit: 'tbsp', name: 'nonfat Greek yogurt' },
      { amount: 0.5, unit: 'cup', name: 'cucumber, diced' },
      { amount: 6, unit: '', name: 'kalamata olives, chopped' },
      { amount: 1, unit: 'cup', name: 'romaine, shredded' },
      { amount: 0.5, unit: '', name: 'lemon, juiced' },
    ],
    steps: [
      'Flake the tuna into a bowl and stir in the yogurt, cucumber, olives, and lemon.',
      'Warm the wrap for 10 seconds so it rolls without cracking.',
      'Layer on the romaine, then the tuna salad.',
      'Roll tightly, slice in half, and serve.',
    ],
  },
  {
    id: 'rec_lentil_soup',
    name: 'Lentil & Vegetable Soup',
    meal: 'lunch',
    tags: ['Vegetarian', 'Meal prep', 'Fiber'],
    minutes: 40,
    servings: 4,
    calories: 290, protein: 18, carbs: 42, fat: 5,
    description: 'A pot of slow-simmered lentils with carrot, celery, and tomato — freezes beautifully for protocol weeks.',
    ingredients: [
      { amount: 1, unit: 'cup', name: 'dried green lentils, rinsed' },
      { amount: 2, unit: '', name: 'carrots, diced' },
      { amount: 2, unit: 'stalks', name: 'celery, diced' },
      { amount: 1, unit: '', name: 'yellow onion, diced' },
      { amount: 1, unit: 'can', name: 'diced tomatoes (14 oz)' },
      { amount: 4, unit: 'cups', name: 'low-sodium vegetable broth' },
      { amount: 1, unit: 'tbsp', name: 'olive oil' },
      { amount: 1, unit: 'tsp', name: 'ground cumin' },
      { amount: 0, unit: '', name: 'Fresh parsley, to garnish' },
    ],
    steps: [
      'Sweat the onion, carrot, and celery in olive oil for 5 minutes.',
      'Stir in the cumin and cook 30 seconds until fragrant.',
      'Add lentils, tomatoes, and broth; bring to a boil.',
      'Simmer uncovered 28–30 minutes until the lentils are tender.',
      'Season, ladle into bowls, and finish with parsley.',
    ],
  },
  {
    id: 'rec_shrimp_zoodles',
    name: 'Shrimp & Zucchini Noodle Bowl',
    meal: 'lunch',
    tags: ['Low carb', 'High protein', 'Under 30 min', 'Pescatarian'],
    minutes: 20,
    servings: 1,
    calories: 300, protein: 34, carbs: 12, fat: 13,
    description: 'Garlicky seared shrimp over ribbons of zucchini with burst cherry tomatoes — pasta-night energy, salad-night macros.',
    ingredients: [
      { amount: 6, unit: 'oz', name: 'shrimp, peeled' },
      { amount: 2, unit: '', name: 'zucchini, spiralized' },
      { amount: 2, unit: 'cloves', name: 'garlic, minced' },
      { amount: 0.75, unit: 'cup', name: 'cherry tomatoes' },
      { amount: 1, unit: 'tbsp', name: 'olive oil' },
      { amount: 0.5, unit: '', name: 'lemon, juiced' },
      { amount: 0, unit: '', name: 'Fresh parsley, to garnish' },
    ],
    steps: [
      'Sear the shrimp in half the oil, 90 seconds per side; set aside.',
      'Add the remaining oil, garlic, and tomatoes; cook until the tomatoes burst.',
      'Toss in the zucchini noodles for 60–90 seconds — just until warmed.',
      'Return the shrimp, squeeze over the lemon, and top with parsley.',
    ],
  },
  // Dinner
  {
    id: 'rec_baked_salmon',
    name: 'Baked Salmon & Asparagus',
    meal: 'dinner',
    tags: ['High protein', 'Low carb', 'Under 30 min', 'Pescatarian'],
    minutes: 25,
    servings: 1,
    calories: 430, protein: 38, carbs: 10, fat: 26,
    description: 'One sheet pan, twenty-five minutes — dill-crusted salmon beside blistered asparagus with charred lemon.',
    ingredients: [
      { amount: 6, unit: 'oz', name: 'salmon fillet' },
      { amount: 8, unit: 'spears', name: 'asparagus, trimmed' },
      { amount: 1, unit: 'tbsp', name: 'olive oil' },
      { amount: 1, unit: '', name: 'lemon, half sliced, half juiced' },
      { amount: 1, unit: 'tsp', name: 'chopped fresh dill' },
      { amount: 1, unit: 'clove', name: 'garlic, minced' },
    ],
    steps: [
      'Heat the oven to 400°F and line a sheet pan.',
      'Toss the asparagus with half the oil and spread on one side of the pan.',
      'Rub the salmon with the remaining oil, garlic, and dill; lay skin-side down.',
      'Top with lemon slices and bake 14–16 minutes until the salmon flakes.',
      'Finish with the reserved lemon juice.',
    ],
  },
  {
    id: 'rec_roast_chicken',
    name: 'Herb Roast Chicken & Vegetables',
    meal: 'dinner',
    tags: ['High protein', 'Meal prep'],
    minutes: 45,
    servings: 2,
    calories: 410, protein: 42, carbs: 22, fat: 16,
    description: 'A Sunday-style tray roast scaled for two — thyme-rubbed chicken over carrots, brussels sprouts, and red onion.',
    ingredients: [
      { amount: 12, unit: 'oz', name: 'chicken breast' },
      { amount: 3, unit: '', name: 'carrots, cut into chunks' },
      { amount: 2, unit: 'cups', name: 'brussels sprouts, halved' },
      { amount: 1, unit: '', name: 'red onion, wedged' },
      { amount: 1.5, unit: 'tbsp', name: 'olive oil' },
      { amount: 1, unit: 'tsp', name: 'dried thyme' },
      { amount: 1, unit: 'tsp', name: 'chopped rosemary' },
      { amount: 0, unit: '', name: 'Salt and pepper, to taste' },
    ],
    steps: [
      'Heat the oven to 425°F.',
      'Toss the vegetables with two-thirds of the oil and spread on a sheet pan; roast 10 minutes.',
      'Rub the chicken with the remaining oil and herbs.',
      'Nestle the chicken among the vegetables and roast 22–25 minutes more.',
      'Rest the chicken 5 minutes before slicing.',
    ],
  },
  {
    id: 'rec_turkey_meatballs',
    name: 'Turkey Meatballs & Zoodles',
    meal: 'dinner',
    tags: ['High protein', 'Low carb'],
    minutes: 35,
    servings: 2,
    calories: 390, protein: 36, carbs: 18, fat: 19,
    description: 'Tender turkey meatballs simmered in marinara and served over quick-sautéed zucchini noodles.',
    ingredients: [
      { amount: 12, unit: 'oz', name: 'ground turkey' },
      { amount: 1, unit: '', name: 'large egg' },
      { amount: 0.25, unit: 'cup', name: 'almond flour' },
      { amount: 1, unit: 'cup', name: 'marinara sauce' },
      { amount: 3, unit: '', name: 'zucchini, spiralized' },
      { amount: 2, unit: 'cloves', name: 'garlic, minced' },
      { amount: 0, unit: '', name: 'Fresh basil, to garnish' },
    ],
    steps: [
      'Mix the turkey, egg, almond flour, and garlic; roll into 12 meatballs.',
      'Brown the meatballs in a wide skillet, about 6 minutes.',
      'Pour in the marinara, cover, and simmer 12 minutes.',
      'In a second pan, sauté the zucchini noodles 2 minutes.',
      'Serve the meatballs and sauce over the zoodles with torn basil.',
    ],
  },
  {
    id: 'rec_seared_cod',
    name: 'Seared Cod & Broccolini',
    meal: 'dinner',
    tags: ['Low carb', 'Under 30 min', 'Pescatarian'],
    minutes: 20,
    servings: 1,
    calories: 320, protein: 34, carbs: 9, fat: 16,
    description: 'Golden-crusted cod with charred broccolini and a one-tablespoon lemon butter that tastes like far more.',
    ingredients: [
      { amount: 6, unit: 'oz', name: 'cod fillet' },
      { amount: 1, unit: 'bunch', name: 'broccolini, trimmed' },
      { amount: 1, unit: 'tbsp', name: 'butter' },
      { amount: 2, unit: 'cloves', name: 'garlic, sliced' },
      { amount: 0.5, unit: '', name: 'lemon, juiced' },
      { amount: 0.25, unit: 'tsp', name: 'chili flakes' },
    ],
    steps: [
      'Pat the cod very dry and season well.',
      'Char the broccolini in a dry skillet 4–5 minutes; set aside.',
      'Sear the cod in half the butter, 3–4 minutes per side.',
      'Add the remaining butter, garlic, and chili flakes; baste 30 seconds.',
      'Finish everything with lemon juice.',
    ],
  },
  {
    id: 'rec_beef_stirfry',
    name: 'Lean Beef Stir-Fry',
    meal: 'dinner',
    tags: ['High protein', 'Under 30 min'],
    minutes: 25,
    servings: 2,
    calories: 400, protein: 34, carbs: 24, fat: 18,
    description: 'Sirloin strips flash-fried with peppers, broccoli, and snap peas in a ginger-soy glaze. Serve as-is or over cauliflower rice.',
    ingredients: [
      { amount: 10, unit: 'oz', name: 'sirloin, thinly sliced' },
      { amount: 2, unit: '', name: 'bell peppers, sliced' },
      { amount: 2, unit: 'cups', name: 'broccoli florets' },
      { amount: 1, unit: 'cup', name: 'snap peas' },
      { amount: 2, unit: 'tbsp', name: 'low-sodium soy sauce' },
      { amount: 1, unit: 'tbsp', name: 'fresh ginger, grated' },
      { amount: 2, unit: 'cloves', name: 'garlic, minced' },
      { amount: 1, unit: 'tsp', name: 'sesame oil' },
    ],
    steps: [
      'Sear the beef in a screaming-hot wok, 2 minutes; remove.',
      'Stir-fry the broccoli, peppers, and snap peas 3–4 minutes.',
      'Add the garlic and ginger; toss 30 seconds.',
      'Return the beef with the soy sauce and sesame oil; toss to glaze.',
    ],
  },
  // Snacks
  {
    id: 'rec_energy_bites',
    name: 'Almond Energy Bites',
    meal: 'snacks',
    tags: ['Meal prep', 'Vegetarian'],
    minutes: 15,
    servings: 8,
    calories: 180, protein: 6, carbs: 18, fat: 10,
    description: 'No-bake oat and almond butter bites — roll a batch on Sunday, grab two when the afternoon dip hits.',
    ingredients: [
      { amount: 1, unit: 'cup', name: 'rolled oats' },
      { amount: 0.5, unit: 'cup', name: 'almond butter' },
      { amount: 3, unit: 'tbsp', name: 'honey' },
      { amount: 2, unit: 'tbsp', name: 'chia seeds' },
      { amount: 0.25, unit: 'cup', name: 'dark chocolate chips' },
      { amount: 0.5, unit: 'tsp', name: 'vanilla extract' },
    ],
    steps: [
      'Stir every ingredient together in one bowl until it holds when pressed.',
      'Chill the mixture 10 minutes so it firms up.',
      'Roll into 16 bites (two bites per serving).',
      'Store refrigerated up to one week.',
    ],
  },
  {
    id: 'rec_cucumber_hummus',
    name: 'Cucumber Hummus Bites',
    meal: 'snacks',
    tags: ['Vegetarian', 'Low carb', 'Under 15 min'],
    minutes: 10,
    servings: 2,
    calories: 120, protein: 5, carbs: 14, fat: 6,
    description: 'Cool cucumber rounds piped with hummus and dusted with paprika — crunchy, salty, and almost free.',
    ingredients: [
      { amount: 1, unit: '', name: 'large cucumber, cut into rounds' },
      { amount: 0.5, unit: 'cup', name: 'hummus' },
      { amount: 0.25, unit: 'tsp', name: 'smoked paprika' },
      { amount: 1, unit: 'tsp', name: 'olive oil' },
    ],
    steps: [
      'Slice the cucumber into thick rounds and pat dry.',
      'Top each round with a small spoonful of hummus.',
      'Dust with paprika and finish with a few drops of olive oil.',
    ],
  },
  {
    id: 'rec_apple_almond',
    name: 'Apple & Almond Butter',
    meal: 'snacks',
    tags: ['Under 15 min', 'Vegetarian'],
    minutes: 5,
    servings: 1,
    calories: 190, protein: 5, carbs: 24, fat: 10,
    description: 'The simplest snack on the plan — crisp apple slices fanned around a measured spoon of almond butter.',
    ingredients: [
      { amount: 1, unit: '', name: 'crisp apple' },
      { amount: 1, unit: 'tbsp', name: 'almond butter' },
      { amount: 0.25, unit: 'tsp', name: 'ground cinnamon' },
    ],
    steps: [
      'Core the apple and cut into thin wedges.',
      'Spoon the almond butter into a small dish for dipping.',
      'Dust everything with cinnamon.',
    ],
  },
  {
    id: 'rec_boiled_eggs',
    name: 'Seasoned Hard-Boiled Eggs',
    meal: 'snacks',
    tags: ['High protein', 'Low carb', 'Meal prep'],
    minutes: 15,
    servings: 2,
    calories: 140, protein: 12, carbs: 1, fat: 9,
    description: 'Jammy-centered eggs halved and showered with everything bagel seasoning. Boil six, snack for three days.',
    ingredients: [
      { amount: 4, unit: '', name: 'large eggs' },
      { amount: 1, unit: 'tsp', name: 'everything bagel seasoning' },
    ],
    steps: [
      'Lower the eggs into boiling water and cook exactly 9 minutes.',
      'Transfer to an ice bath for 5 minutes, then peel.',
      'Halve lengthwise and sprinkle with the seasoning.',
    ],
  },
  {
    id: 'rec_protein_smoothie',
    name: 'Chocolate Protein Smoothie',
    meal: 'snacks',
    tags: ['High protein', 'Under 15 min'],
    minutes: 5,
    servings: 1,
    calories: 280, protein: 30, carbs: 28, fat: 6,
    description: 'Tastes like a milkshake, logs like a snack — chocolate whey blended with banana and almond milk over ice.',
    ingredients: [
      { amount: 1, unit: 'scoop', name: 'chocolate whey protein' },
      { amount: 1, unit: '', name: 'ripe banana' },
      { amount: 1, unit: 'cup', name: 'unsweetened almond milk' },
      { amount: 1, unit: 'tbsp', name: 'unsweetened cocoa powder' },
      { amount: 1, unit: 'cup', name: 'ice' },
    ],
    steps: [
      'Add the almond milk, protein, cocoa, and banana to a blender.',
      'Top with ice and blend 45 seconds until completely smooth.',
      'Pour into a tall glass and drink cold.',
    ],
  },
];

export function findRecipe(id: string): Recipe | undefined {
  return RECIPES.find(r => r.id === id);
}

const BREAKFASTS = RECIPES.filter(r => r.meal === 'breakfast');
const LUNCHES = RECIPES.filter(r => r.meal === 'lunch');
const DINNERS = RECIPES.filter(r => r.meal === 'dinner');
const SNACK_RECIPES = RECIPES.filter(r => r.meal === 'snacks');

// ─── Seeded history ──────────────────────────────────────────────────────────

export const SEED_DAYS = 60;

/** Oldest day reachable in the diary — the horizon of the seeded history. */
export const DIARY_MIN_KEY = toDateKey(subDays(TODAY, SEED_DAYS));

function entryFromRecipe(dateKey: string, meal: MealSlot, recipe: Recipe, n: number): MealLogEntry {
  return {
    id: `seed_${dateKey}_${meal}_${n}`,
    dateKey,
    meal,
    kind: 'recipe',
    refId: recipe.id,
    name: recipe.name,
    detail: '1 serving',
    quantity: 1,
    calories: recipe.calories,
    protein: recipe.protein,
    carbs: recipe.carbs,
    fat: recipe.fat,
  };
}

function entryFromFood(dateKey: string, meal: MealSlot, food: FoodItem, quantity: number, n: number): MealLogEntry {
  return {
    id: `seed_${dateKey}_${meal}_${n}`,
    dateKey,
    meal,
    kind: 'food',
    refId: food.id,
    name: food.name,
    detail: quantity === 1 ? food.serving : `${quantity} × ${food.serving}`,
    quantity,
    calories: Math.round(food.calories * quantity),
    protein: Math.round(food.protein * quantity),
    carbs: Math.round(food.carbs * quantity),
    fat: Math.round(food.fat * quantity),
  };
}

const pickFrom = <T,>(arr: T[], seed: number): T => arr[Math.floor(seededFraction(seed) * arr.length) % arr.length];

/** Diary entries for the past SEED_DAYS days plus a partial log for today. */
export function buildSeedEntries(): MealLogEntry[] {
  const entries: MealLogEntry[] = [];

  for (let offset = SEED_DAYS; offset >= 1; offset--) {
    const dateKey = toDateKey(subDays(TODAY, offset));

    entries.push(entryFromRecipe(dateKey, 'breakfast', pickFrom(BREAKFASTS, offset * 7 + 1), 0));
    if (seededFraction(offset * 11 + 4) < 0.72) {
      entries.push(entryFromFood(dateKey, 'breakfast', findFood('fd_coffee')!, 1, 1));
    }

    entries.push(entryFromRecipe(dateKey, 'lunch', pickFrom(LUNCHES, offset * 7 + 2), 0));
    if (seededFraction(offset * 11 + 5) < 0.38) {
      const extra = seededFraction(offset * 13 + 6) < 0.5 ? 'fd_apple' : 'fd_sparkling';
      entries.push(entryFromFood(dateKey, 'lunch', findFood(extra)!, 1, 1));
    }

    entries.push(entryFromRecipe(dateKey, 'dinner', pickFrom(DINNERS, offset * 7 + 3), 0));

    if (seededFraction(offset * 11 + 6) < 0.55) {
      entries.push(entryFromRecipe(dateKey, 'snacks', pickFrom(SNACK_RECIPES, offset * 7 + 4), 0));
    }
  }

  // Today: breakfast, lunch, and a snack are logged; dinner is still open so
  // "calories remaining" reads meaningfully in the demo.
  entries.push(entryFromRecipe(TODAY_KEY, 'breakfast', findRecipe('rec_yogurt_bowl')!, 0));
  entries.push(entryFromFood(TODAY_KEY, 'breakfast', findFood('fd_coffee')!, 1, 1));
  entries.push(entryFromRecipe(TODAY_KEY, 'lunch', findRecipe('rec_cobb_salad')!, 0));
  entries.push(entryFromRecipe(TODAY_KEY, 'snacks', findRecipe('rec_apple_almond')!, 0));

  return entries;
}

/** Water totals (fl oz) keyed by date, including a partial total for today. */
export function buildSeedWater(): Record<string, number> {
  const water: Record<string, number> = {};
  for (let offset = SEED_DAYS; offset >= 1; offset--) {
    const dateKey = toDateKey(subDays(TODAY, offset));
    water[dateKey] = 40 + Math.floor(seededFraction(offset * 13 + 5) * 5) * 8; // 40–72 oz
  }
  water[TODAY_KEY] = 32;
  return water;
}

/** Emma's weight on a given program day, matching the staff-side taper curve. */
function weightOnProgramDay(elapsed: number): number {
  const start = PATIENT_PROFILE.startingWeight;
  const current = PATIENT_PROFILE.currentWeight;
  const progress = Math.min(1, Math.max(0, elapsed / ENROLLMENT_DAYS));
  const taper = Math.pow(progress, 0.78);
  const variation = elapsed === 0 || elapsed >= ENROLLMENT_DAYS
    ? 0
    : (seededFraction(elapsed * 41 + 7) - 0.5) * 1.1;
  const weight = start - (start - current) * taper + variation;
  return parseFloat(Math.max(current - 0.4, weight).toFixed(1));
}

const CHECKIN_NOTES = [
  'Felt steady today. Meals were easy to stick to.',
  'Busy day but kept up with water and walks.',
  'Slept well and energy is holding.',
  'Prepped meals for the next two days.',
  'Craving hit in the afternoon — tea helped.',
  'Weekend routine held up better than expected.',
];

/** Daily check-ins over the seeded window (a few days are skipped). */
export function buildSeedCheckIns(): CheckIn[] {
  const checkIns: CheckIn[] = [];
  for (let offset = SEED_DAYS; offset >= 1; offset--) {
    if (seededFraction(offset * 3 + 2) < 0.16) continue; // occasional missed day
    const dateKey = toDateKey(subDays(TODAY, offset));
    const elapsed = ENROLLMENT_DAYS - offset;
    const moodRoll = seededFraction(offset * 5 + 9);
    const mood: 1 | 2 | 3 | 4 | 5 = moodRoll < 0.1 ? 3 : moodRoll > 0.72 ? 5 : 4;
    const sideEffects = seededFraction(offset * 9 + 3) < 0.08 ? ['Headache'] : [];
    const checkIn: CheckIn = {
      id: `seed_ci_${dateKey}`,
      dateKey,
      mood,
      sideEffects,
    };
    if (offset % 2 === 0) checkIn.weight = weightOnProgramDay(elapsed);
    if (seededFraction(offset * 17 + 11) < 0.3) {
      checkIn.notes = CHECKIN_NOTES[Math.floor(seededFraction(offset * 19 + 13) * CHECKIN_NOTES.length) % CHECKIN_NOTES.length];
    }
    checkIns.push(checkIn);
  }
  return checkIns;
}

/** Seeded progress photos at program milestones (generated illustrations). */
export const SEED_PHOTOS: ProgressPhoto[] = [
  { id: 'photo_baseline', dateKey: toDateKey(ENROLLMENT_DATE), label: 'Baseline', source: 'seed' },
  { id: 'photo_week2', dateKey: toDateKey(addDays(ENROLLMENT_DATE, 14)), label: 'Week 2', source: 'seed' },
  { id: 'photo_week4', dateKey: toDateKey(addDays(ENROLLMENT_DATE, 28)), label: 'Week 4', source: 'seed' },
  { id: 'photo_week6', dateKey: toDateKey(addDays(ENROLLMENT_DATE, 42)), label: 'Week 6', source: 'seed' },
];

/** Weight for the milestone photo captions. */
export function weightAtDateKey(dateKey: string): number {
  const elapsed = Math.round((new Date(`${dateKey}T12:00:00.000Z`).getTime() - ENROLLMENT_DATE.getTime()) / 86_400_000);
  return weightOnProgramDay(elapsed);
}
