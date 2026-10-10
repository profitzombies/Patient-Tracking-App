/**
 * THINNR diet library — canonical content.
 *
 * This file is the source of record for the 26 selectable diet frameworks
 * plus "No specific diet, just tracking". The database seed migration is
 * rendered FROM this file (see scripts/render-seed.ts) and a test proves the
 * two never drift. HQ edits land in the database afterwards; this file is the
 * launch content, not a mirror of later edits.
 *
 * Rule sheets are drafted from the named standard sources (AHA, ADA, USDA
 * Dietary Guidelines, Monash University for FODMAP, NIH/NIDDK, ACOG) with
 * general nutrition knowledge filling gaps. Condition claims are deliberately
 * absent pending counsel review; every entry ships as `draft` except the
 * tracking-only option, and only `published` entries reach patients.
 */
import type { DietComplexity, EvidenceStrength, FoodTag, ScreeningQuestion, SupervisionLevel } from "./vocabulary";

export interface DietFitRules {
  /** exclude: anything not excluded fits. include: only foods carrying an include tag fit. */
  mode: "exclude" | "include";
  excludeTags?: FoodTag[];
  /** Allowed, but the diet asks for moderation; the verdict stays "fits" with a note. */
  limitTags?: FoodTag[];
  includeTags?: FoodTag[];
  /** Grams of carbohydrate per serving above which a food does not fit (when macros are known). */
  maxCarbsPerServing?: number;
  /** Calories per gram above which a food does not fit (when serving grams are known). */
  maxEnergyDensity?: number;
  forbiddenCombinations?: FoodTag[][];
}

export interface DietCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  complexity: DietComplexity;
  ruleSheet: string[];
  sampleDay: string[];
  oversightNote: boolean;
  pregnancyBlocked: boolean;
  screeningQuestions: ScreeningQuestion[];
  fitRules: DietFitRules;
  evidenceStrength: EvidenceStrength;
  supervisionLevel: SupervisionLevel;
  sources: string[];
  sortOrder: number;
}

export const JUST_TRACKING_SLUG = "just_tracking";
export const GLP1_COMPANION_SLUG = "glp1_companion";
export const FERTILITY_PREGNANCY_SLUG = "fertility_pregnancy";

export const DIET_DISCLAIMER =
  "This information is general nutrition education, not medical advice. It does not diagnose, treat, cure or prevent any condition. " +
  "Talk with your care team before changing how you eat, especially if you take medication, are pregnant or breastfeeding, or have a medical condition.";

export const OVERSIGHT_NOTE_TEXT = "This plan works best with support. Consider talking to your care team before you start.";

const ANIMAL: FoodTag[] = ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish"];
const DAIRY: FoodTag[] = ["dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "lactose"];
const GRAINS: FoodTag[] = ["grain", "whole_grain", "refined_grain", "gluten", "wheat", "corn", "rice"];
const SUGARS: FoodTag[] = ["added_sugar", "sweetened_beverage"];

export const DIET_CATALOG: readonly DietCatalogEntry[] = [
  {
    slug: JUST_TRACKING_SLUG,
    name: "No specific diet, just tracking",
    summary: "Log what you eat and drink without following a named plan. Your calorie and macro targets still come from your goals.",
    complexity: "simple",
    ruleSheet: [
      "There are no food rules. Any allergies, sensitivities, restrictions and dislikes you record still apply.",
      "Aim to log every meal, snack and drink so your targets mean something.",
      "Weigh in at your weekly check-in and keep your activity level current.",
    ],
    sampleDay: ["Breakfast: whatever you normally eat, logged.", "Lunch: logged with portions.", "Dinner: logged with portions.", "Snacks and drinks: logged as you go."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: [] },
    evidenceStrength: "strong", supervisionLevel: "none", sources: ["USDA Dietary Guidelines for Americans 2020-2025"], sortOrder: 0,
  },
  {
    slug: "intermittent_fasting",
    name: "Intermittent fasting",
    summary: "Eat within a daily window (for example 8 hours) and fast the rest of the day. What you eat stays flexible; when you eat is the rule.",
    complexity: "simple",
    ruleSheet: [
      "Pick an eating window and keep it most days. 16:8 (16 hours fasting, 8 hours eating) is the common starting point; 14:10 is gentler.",
      "During the fast: water, black coffee, plain tea. No calories, no sweetened drinks.",
      "Inside the window, build meals around protein, vegetables, fruit and whole grains so you are not short on nutrients.",
      "Do not fast if you take insulin or medication that can cause low blood sugar unless your prescriber has adjusted your plan.",
      "Stop and eat if you feel faint, shaky or confused.",
      "Your fasting window is saved in your diet settings and the coach uses it to time suggestions.",
    ],
    sampleDay: ["Fasting 8 pm to 12 pm: water, black coffee, tea.", "12 pm: Grilled chicken salad with olive oil, chickpeas and an apple.", "3:30 pm: Greek yogurt with berries and walnuts.", "7 pm: Salmon, roasted vegetables and quinoa. Window closes at 8 pm."],
    oversightNote: true, pregnancyBlocked: true, screeningQuestions: ["medication", "pregnancy"],
    fitRules: { mode: "exclude", excludeTags: [] },
    evidenceStrength: "moderate", supervisionLevel: "recommended", sources: ["American Heart Association scientific statement on meal timing (2017)", "American Diabetes Association Standards of Care, nutrition therapy"], sortOrder: 1,
  },
  {
    slug: GLP1_COMPANION_SLUG,
    name: "GLP-1 companion",
    summary: "Smaller, protein-first meals that sit well while you are on a GLP-1 medication, with attention to fluids, fiber and keeping muscle.",
    complexity: "simple",
    ruleSheet: [
      "Protein first at every meal: eggs, poultry, fish, lean meat, tofu, Greek yogurt or legumes. Aim for a palm-sized portion before anything else.",
      "Eat smaller meals and stop at the first sign of fullness. Nausea often follows big or greasy meals.",
      "Limit fried, very fatty and ultra-processed foods and sugary drinks; they are the most common triggers for stomach upset.",
      "Drink water through the day. Add fiber gradually (vegetables, fruit, oats, beans) to keep digestion moving.",
      "Keep moving and keep protein up to protect muscle while weight comes off.",
      "Tell your care team about vomiting, severe stomach pain or not being able to keep fluids down.",
    ],
    sampleDay: ["Breakfast: Two scrambled eggs with spinach, half a slice of whole-grain toast.", "Lunch: Turkey and avocado lettuce wraps, cucumber slices.", "Snack: Cottage cheese with pineapple.", "Dinner: Baked cod, steamed green beans, small baked sweet potato.", "Fluids: water or herbal tea between meals."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["fried", "ultra_processed", "sweetened_beverage", "trans_fat"], limitTags: ["high_fat", "added_sugar", "alcohol", "carbonated"] },
    evidenceStrength: "moderate", supervisionLevel: "recommended", sources: ["American Diabetes Association Standards of Care", "Academy of Nutrition and Dietetics guidance on GLP-1 receptor agonists"], sortOrder: 2,
  },
  {
    slug: "mediterranean",
    name: "Mediterranean",
    summary: "Vegetables, fruit, whole grains, beans, nuts, olive oil and fish most days; poultry and dairy in moderation; red and processed meat rarely.",
    complexity: "simple",
    ruleSheet: [
      "Make vegetables, fruit, legumes, nuts and whole grains the base of every meal.",
      "Use extra-virgin olive oil as the main fat.",
      "Fish and seafood at least twice a week; poultry, eggs, cheese and yogurt in moderate amounts.",
      "Red meat a few times a month at most. Avoid processed meat, sugary drinks, added sugar and refined grains.",
      "Herbs, spices, garlic and citrus instead of salt.",
      "If you drink alcohol, keep it to a small glass of wine with a meal.",
    ],
    sampleDay: ["Breakfast: Greek yogurt with figs, walnuts and a drizzle of honey.", "Lunch: Lentil and vegetable soup, whole-grain bread, olive oil.", "Snack: Hummus with carrot and pepper sticks.", "Dinner: Grilled sardines or salmon, tomato-cucumber salad, farro."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["processed_meat", "ultra_processed", "sweetened_beverage", "trans_fat"], limitTags: ["red_meat", "added_sugar", "refined_grain", "high_fat_dairy", "butter", "alcohol"] },
    evidenceStrength: "strong", supervisionLevel: "none", sources: ["American Heart Association, Mediterranean diet guidance", "USDA Dietary Guidelines Healthy Mediterranean-Style Dietary Pattern"], sortOrder: 3,
  },
  {
    slug: "keto",
    name: "Keto",
    summary: "Very low carbohydrate, moderate protein and high fat so the body runs mainly on fat. Strict and effective for some, but not for everyone.",
    complexity: "advanced",
    ruleSheet: [
      "Keep total carbohydrate very low, usually under 20 to 50 grams a day. Most of those come from non-starchy vegetables.",
      "No grains, bread, pasta, rice, sugar, sweets, sugary drinks, most fruit, potatoes, beans or lentils.",
      "Eat: meat, poultry, fish, eggs, cheese, butter, olive oil, avocado, nuts, seeds, leafy greens and other low-carb vegetables. Berries in small amounts.",
      "Drink plenty of water and add salt, potassium and magnesium-rich foods; the first two weeks can bring headaches and fatigue.",
      "If you take insulin or diabetes medication, your dose may need to change quickly. Do not start without your prescriber.",
      "Not recommended during pregnancy or breastfeeding, or with a history of pancreatitis, gallbladder disease or certain metabolic conditions.",
    ],
    sampleDay: ["Breakfast: Omelet with cheese, spinach and avocado.", "Lunch: Chicken thigh salad with olive oil and feta.", "Snack: Macadamia nuts.", "Dinner: Ribeye or salmon with buttered broccoli and cauliflower mash."],
    oversightNote: true, pregnancyBlocked: true, screeningQuestions: ["medication", "pregnancy"],
    fitRules: { mode: "exclude", excludeTags: [...GRAINS, ...SUGARS, "sweetener", "legume", "starchy_vegetable", "high_sugar_fruit", "honey", "beer"], limitTags: ["fruit", "milk"], maxCarbsPerServing: 10 },
    evidenceStrength: "moderate", supervisionLevel: "required", sources: ["American Diabetes Association Standards of Care, low-carbohydrate eating patterns", "NIH/NIDDK nutrition guidance"], sortOrder: 4,
  },
  {
    slug: "low_glycemic",
    name: "Low-glycemic / plate method",
    summary: "Half the plate vegetables, a quarter protein, a quarter slow carbohydrate. Steady energy without counting every gram.",
    complexity: "simple",
    ruleSheet: [
      "Plate method at each meal: half non-starchy vegetables, one quarter lean protein, one quarter whole grains, beans or starchy vegetables.",
      "Choose slow carbohydrates: oats, barley, quinoa, brown rice, beans, lentils, sweet potato, whole fruit.",
      "Skip white bread, white rice, pastries, candy, sugary cereal and sugary drinks.",
      "Pair carbohydrate with protein or fat to slow the rise in blood sugar.",
      "Water, unsweetened tea or coffee as the default drink.",
    ],
    sampleDay: ["Breakfast: Steel-cut oats with berries and almonds.", "Lunch: Half plate salad greens, grilled chicken, half cup black beans.", "Snack: Apple with peanut butter.", "Dinner: Half plate roasted vegetables, baked fish, half cup quinoa."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["refined_grain", ...SUGARS, "trans_fat"], limitTags: ["high_sugar_fruit", "fried", "ultra_processed"] },
    evidenceStrength: "strong", supervisionLevel: "none", sources: ["American Diabetes Association Diabetes Plate Method", "USDA MyPlate"], sortOrder: 5,
  },
  {
    slug: "whole_food_plant_based",
    name: "Whole-food plant-based",
    summary: "Mostly or entirely plants, as unprocessed as possible: vegetables, fruit, whole grains, legumes, nuts and seeds, with little added oil.",
    complexity: "moderate",
    ruleSheet: [
      "Build every meal from vegetables, fruit, whole grains, beans, lentils, nuts and seeds.",
      "Avoid meat, poultry, fish, eggs and dairy. If you keep small amounts of animal food, the Flexitarian plan may fit better.",
      "Minimize added oils, refined grains, added sugar and packaged foods with long ingredient lists.",
      "Get protein from legumes, tofu, tempeh, whole grains and nuts at every meal.",
      "Take a vitamin B12 supplement and check with your care team about vitamin D, iron and omega-3 sources.",
    ],
    sampleDay: ["Breakfast: Oatmeal with banana, chia seeds and cinnamon.", "Lunch: Black bean and sweet potato bowl with brown rice and salsa.", "Snack: Edamame.", "Dinner: Lentil bolognese over whole-wheat pasta, big green salad with lemon-tahini dressing."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: [...ANIMAL, "egg", "raw_egg", ...DAIRY, "ultra_processed", "refined_grain", ...SUGARS, "fried", "trans_fat"], limitTags: ["olive_oil", "seed_oil", "honey"] },
    evidenceStrength: "strong", supervisionLevel: "none", sources: ["USDA Dietary Guidelines Healthy Vegetarian Dietary Pattern", "American Heart Association, plant-based diets"], sortOrder: 6,
  },
  {
    slug: "flexitarian",
    name: "Flexitarian",
    summary: "Mostly vegetarian with meat or fish now and then. The easiest way to eat more plants without giving anything up completely.",
    complexity: "simple",
    ruleSheet: [
      "Most meals vegetarian: legumes, tofu, eggs, dairy, whole grains, vegetables and fruit.",
      "Meat, poultry or fish a few times a week in modest portions; when you do, prefer fish and poultry over red meat.",
      "Limit processed meat, added sugar and ultra-processed snacks.",
      "Plan plant protein deliberately so you are not just dropping meat without a replacement.",
    ],
    sampleDay: ["Breakfast: Veggie omelet with whole-grain toast.", "Lunch: Chickpea and quinoa salad.", "Snack: Trail mix.", "Dinner: Stir-fried tofu and vegetables (or chicken twice a week) with brown rice."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["processed_meat", "ultra_processed", "sweetened_beverage", "trans_fat"], limitTags: ["meat", "red_meat", "pork", "poultry", "added_sugar"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["USDA Dietary Guidelines Healthy Vegetarian Dietary Pattern"], sortOrder: 7,
  },
  {
    slug: "paleo",
    name: "Paleo",
    summary: "Meat, fish, eggs, vegetables, fruit, nuts and seeds. No grains, legumes, dairy, refined sugar or processed food.",
    complexity: "moderate",
    ruleSheet: [
      "Eat: meat, poultry, fish, eggs, vegetables, fruit, nuts, seeds, olive oil, avocado and coconut oil.",
      "Avoid: all grains (including corn and rice), legumes (beans, lentils, peanuts, soy), dairy, refined sugar, seed oils and processed foods.",
      "Potatoes and sweet potatoes are allowed in most versions; keep portions moderate.",
      "Watch calcium and fiber: eat leafy greens, broccoli, sardines with bones and plenty of vegetables.",
    ],
    sampleDay: ["Breakfast: Eggs with sautéed peppers and avocado.", "Lunch: Grilled steak salad with olive oil and pumpkin seeds.", "Snack: Apple and almonds.", "Dinner: Roast chicken, roasted sweet potato and Brussels sprouts."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: [...GRAINS, "legume", "soy", "peanut", ...DAIRY, ...SUGARS, "sweetener", "seed_oil", "ultra_processed", "artificial_additive", "trans_fat", "processed_meat"], limitTags: ["starchy_vegetable", "honey", "alcohol"] },
    evidenceStrength: "limited", supervisionLevel: "none", sources: ["Academy of Nutrition and Dietetics review of Paleolithic diets"], sortOrder: 8,
  },
  {
    slug: "whole30",
    name: "Whole30",
    summary: "A strict 30-day reset: whole foods only, with no sugar, alcohol, grains, legumes, dairy or additives. Then reintroduce one group at a time.",
    complexity: "advanced",
    ruleSheet: [
      "For 30 days eat meat, seafood, eggs, vegetables, fruit, natural fats, herbs and spices.",
      "No added sugar of any kind (real or artificial), no alcohol, no grains, no legumes (including peanuts and soy), no dairy, no carrageenan, MSG or sulfites.",
      "No recreating baked goods or treats with approved ingredients.",
      "Do not weigh yourself during the 30 days; your weekly check-in weight is recorded by your care team.",
      "After day 30 reintroduce one food group at a time over several days and note how you feel.",
      "Your start date is saved in your diet settings so the coach can count the days with you.",
      "Not appropriate during pregnancy or breastfeeding or with a history of disordered eating.",
    ],
    sampleDay: ["Breakfast: Sweet potato hash with eggs and spinach.", "Lunch: Tuna salad with olive-oil mayo over greens.", "Snack: Hard-boiled egg and carrot sticks.", "Dinner: Pork chops, roasted cauliflower, sautéed kale."],
    oversightNote: true, pregnancyBlocked: true, screeningQuestions: ["eating_disorder", "pregnancy"],
    fitRules: { mode: "exclude", excludeTags: [...GRAINS, "legume", "soy", "peanut", ...DAIRY, ...SUGARS, "sweetener", "honey", "alcohol", "beer", "ultra_processed", "artificial_additive", "trans_fat", "processed_meat"] },
    evidenceStrength: "limited", supervisionLevel: "recommended", sources: ["Whole30 program rules (official)", "Academy of Nutrition and Dietetics commentary on elimination resets"], sortOrder: 9,
  },
  {
    slug: "anti_inflammatory",
    name: "Anti-inflammatory",
    summary: "Colorful vegetables and fruit, oily fish, olive oil, nuts, whole grains and spices; little sugar, refined grain, fried or processed food.",
    complexity: "simple",
    ruleSheet: [
      "Fill plates with vegetables and fruit of many colors, especially leafy greens and berries.",
      "Oily fish (salmon, sardines, mackerel) two to three times a week; otherwise poultry, legumes, eggs.",
      "Olive oil, nuts and seeds as the main fats. Use turmeric, ginger, garlic and herbs generously.",
      "Avoid fried food, trans fats, processed meat, sugary drinks and sweets. Limit refined grains, red meat and alcohol.",
      "Whole grains and legumes for fiber.",
    ],
    sampleDay: ["Breakfast: Overnight oats with blueberries, flax and walnuts.", "Lunch: Salmon and avocado bowl with brown rice and edamame.", "Snack: Orange and pistachios.", "Dinner: Turmeric chicken with roasted broccoli and sweet potato."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["fried", "trans_fat", "processed_meat", "sweetened_beverage", "ultra_processed"], limitTags: ["added_sugar", "refined_grain", "red_meat", "alcohol"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["American Heart Association, dietary patterns and inflammation", "USDA Dietary Guidelines"], sortOrder: 10,
  },
  {
    slug: "carnivore",
    name: "Carnivore",
    summary: "Animal foods only: meat, fish, eggs and, for some, dairy. No plants at all. Highly restrictive; talk to your care team first.",
    complexity: "advanced",
    ruleSheet: [
      "Eat only animal foods: beef, lamb, pork, poultry, fish, shellfish, eggs, organ meats. Some versions allow butter, hard cheese and cream.",
      "No vegetables, fruit, grains, legumes, nuts, seeds, sugar, plant oils or alcohol.",
      "Salt to taste and drink plenty of water; electrolytes matter in the first weeks.",
      "This plan removes fiber and many vitamins found in plants. Your care team may want baseline and follow-up bloodwork.",
      "Not appropriate during pregnancy or breastfeeding, or with a history of disordered eating.",
    ],
    sampleDay: ["Breakfast: Eggs and bacon.", "Lunch: Ground beef patties with butter.", "Dinner: Ribeye steak or salmon, salted.", "Drinks: water, bone broth."],
    oversightNote: true, pregnancyBlocked: true, screeningQuestions: ["eating_disorder", "pregnancy"],
    fitRules: { mode: "include", includeTags: [...ANIMAL, "egg", "organ_meat", "butter", "aged_cheese"], excludeTags: ["processed_meat", "added_sugar", "sweetener"], limitTags: ["dairy", "milk", "high_fat_dairy"] },
    evidenceStrength: "emerging", supervisionLevel: "required", sources: ["USDA Dietary Guidelines (for the nutrients this pattern omits)", "Academy of Nutrition and Dietetics position on restrictive diets"], sortOrder: 11,
  },
  {
    slug: "dash",
    name: "DASH",
    summary: "Dietary Approaches to Stop Hypertension: fruit, vegetables, whole grains, low-fat dairy, lean protein and nuts, with sodium kept low.",
    complexity: "moderate",
    ruleSheet: [
      "Daily: 4 to 5 servings each of vegetables and fruit, 6 to 8 of whole grains, 2 to 3 of low-fat dairy, up to 6 ounces of lean meat, poultry or fish.",
      "Weekly: 4 to 5 servings of nuts, seeds and legumes; sweets limited to 5 or fewer.",
      "Sodium under 2,300 mg a day (1,500 mg if your care team advises it). Skip cured meats, canned soups, salty snacks and most fast food.",
      "Choose potassium-rich foods: bananas, potatoes, beans, leafy greens, yogurt.",
      "Limit saturated fat, added sugar and alcohol.",
    ],
    sampleDay: ["Breakfast: Oatmeal with banana and low-fat milk.", "Lunch: Turkey sandwich on whole-grain bread with lettuce, tomato and a side of fruit.", "Snack: Unsalted almonds and an orange.", "Dinner: Baked chicken, brown rice, steamed broccoli, side salad with vinaigrette."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["high_sodium", "processed_meat", "sweetened_beverage", "trans_fat", "ultra_processed"], limitTags: ["red_meat", "high_fat_dairy", "butter", "added_sugar", "alcohol", "fried"] },
    evidenceStrength: "strong", supervisionLevel: "none", sources: ["NIH National Heart, Lung, and Blood Institute DASH Eating Plan", "American Heart Association"], sortOrder: 12,
  },
  {
    slug: "volumetrics",
    name: "Volumetrics",
    summary: "Eat more of foods that are low in calories per bite (vegetables, fruit, broth soups, lean protein) and less of dense ones. Fullness without hunger.",
    complexity: "simple",
    ruleSheet: [
      "Start meals with a broth-based soup or a big salad.",
      "Fill up on water-rich foods: vegetables, fruit, lean protein, cooked whole grains, legumes, low-fat dairy.",
      "Keep energy-dense foods (fried food, pastries, cheese, nuts, oils, candy) to small, deliberate portions.",
      "Add vegetables to everything: omelets, pasta, sandwiches, stir-fries.",
      "Drink water rather than caloric drinks.",
    ],
    sampleDay: ["Breakfast: Vegetable omelet with fruit salad.", "Lunch: Minestrone soup and a large mixed salad with grilled shrimp.", "Snack: Air-popped popcorn and grapes.", "Dinner: Turkey chili loaded with beans and peppers, side of roasted zucchini."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["sweetened_beverage", "trans_fat"], limitTags: ["fried", "high_fat", "added_sugar", "ultra_processed", "aged_cheese", "tree_nut", "peanut"], maxEnergyDensity: 4 },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["Penn State Laboratory for the Study of Human Ingestive Behavior (Rolls)", "USDA Dietary Guidelines"], sortOrder: 13,
  },
  {
    slug: "low_fodmap",
    name: "Low FODMAP",
    summary: "A short-term elimination of fermentable carbohydrates that commonly trigger gut symptoms, followed by careful reintroduction. Best done with a dietitian.",
    complexity: "advanced",
    ruleSheet: [
      "Phase 1 (2 to 6 weeks): avoid high-FODMAP foods such as onion, garlic, wheat, rye, most beans, apples, pears, stone fruit, honey, high-fructose corn syrup, milk, soft cheese, cashews, pistachios, sugar alcohols.",
      "Eat low-FODMAP alternatives: rice, oats, quinoa, potatoes, carrots, zucchini, spinach, bell pepper, strawberries, oranges, grapes, lactose-free dairy, hard cheese, eggs, meat, fish, tofu, peanuts, walnuts.",
      "Phase 2: reintroduce one FODMAP group at a time over three days and record symptoms.",
      "Phase 3: build a long-term pattern that avoids only your triggers. This is not meant to be permanent.",
      "Portion size changes FODMAP load; follow the Monash app servings when in doubt.",
    ],
    sampleDay: ["Breakfast: Oats with lactose-free milk, strawberries and walnuts.", "Lunch: Rice bowl with grilled chicken, carrots, cucumber, spinach, sesame oil.", "Snack: Orange and a handful of peanuts.", "Dinner: Baked salmon, roasted potatoes, zucchini, infused garlic oil."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["high_fodmap", "honey", "sweetener"], limitTags: ["legume", "milk", "lactose", "wheat", "high_sugar_fruit"] },
    evidenceStrength: "strong", supervisionLevel: "recommended", sources: ["Monash University Low FODMAP Diet program"], sortOrder: 14,
  },
  {
    slug: "perimenopause_menopause",
    name: "Perimenopause / menopause",
    summary: "Protein and strength-supporting foods, calcium and vitamin D, fiber and plant foods, with less alcohol and added sugar to help with changes in weight, sleep and bone health.",
    complexity: "simple",
    ruleSheet: [
      "Protein at every meal (25 to 30 grams) to hold on to muscle: eggs, fish, poultry, dairy, legumes, tofu.",
      "Calcium-rich foods daily (dairy, fortified plant milk, sardines, leafy greens) and ask your care team about vitamin D.",
      "Mostly plants: vegetables, fruit, whole grains, legumes, nuts and seeds for fiber and phytoestrogens (soy, flax).",
      "Limit alcohol, caffeine late in the day, spicy food and added sugar if they worsen hot flashes or sleep.",
      "Pair this plan with resistance training two or more times a week.",
    ],
    sampleDay: ["Breakfast: Greek yogurt with ground flax, berries and almonds.", "Lunch: Salmon salad with white beans, greens and olive oil.", "Snack: Edamame or a cheese stick with an apple.", "Dinner: Tofu and vegetable stir-fry over brown rice."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["sweetened_beverage", "trans_fat", "ultra_processed"], limitTags: ["alcohol", "caffeine", "added_sugar", "spicy", "refined_grain"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["The Menopause Society position statements", "USDA Dietary Guidelines for Americans"], sortOrder: 15,
  },
  {
    slug: FERTILITY_PREGNANCY_SLUG,
    name: "Fertility / pregnancy",
    summary: "Balanced eating for conception, pregnancy and breastfeeding: folate, iron, choline, omega-3s and enough calories, while avoiding foods that carry risk.",
    complexity: "moderate",
    ruleSheet: [
      "Take a prenatal vitamin with folic acid as your care team directs.",
      "Daily: vegetables, fruit, whole grains, legumes, dairy or fortified alternatives, eggs, poultry, lean meat and low-mercury fish (salmon, sardines, trout, shrimp) two to three times a week.",
      "Avoid alcohol entirely. Limit caffeine to about 200 mg a day (one 12-ounce coffee).",
      "Avoid raw or undercooked meat, fish, shellfish and eggs; unpasteurized milk and soft cheeses; deli meats unless heated; high-mercury fish (shark, swordfish, king mackerel, tilefish, bigeye tuna).",
      "Do not restrict calories or fast. Small frequent meals help with nausea; keep protein and fluids up.",
      "This plan sits alongside your prenatal care; it does not replace it.",
    ],
    sampleDay: ["Breakfast: Fortified whole-grain cereal with milk and a banana; hard-boiled egg.", "Lunch: Lentil soup, whole-grain roll, spinach salad with orange segments.", "Snack: Yogurt with walnuts.", "Dinner: Baked salmon, quinoa, roasted carrots and broccoli."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["alcohol", "beer", "raw_fish", "raw_egg", "unpasteurized", "high_mercury_fish", "processed_meat", "trans_fat"], limitTags: ["caffeine", "coffee", "added_sugar", "ultra_processed"] },
    evidenceStrength: "strong", supervisionLevel: "recommended", sources: ["American College of Obstetricians and Gynecologists, Nutrition During Pregnancy", "USDA Dietary Guidelines, pregnancy and lactation chapter", "FDA/EPA Advice About Eating Fish"], sortOrder: 16,
  },
  {
    slug: "mind",
    name: "MIND",
    summary: "A blend of Mediterranean and DASH that emphasizes leafy greens, berries, nuts, olive oil, whole grains, beans, fish and poultry.",
    complexity: "simple",
    ruleSheet: [
      "Leafy greens six or more times a week and another vegetable daily.",
      "Berries at least twice a week; nuts five or more times a week; beans four or more times a week.",
      "Whole grains three or more servings a day; fish at least once a week; poultry twice a week.",
      "Olive oil as the main fat.",
      "Limit butter and margarine, cheese, red meat, fried and fast food, pastries and sweets.",
    ],
    sampleDay: ["Breakfast: Whole-grain toast with almond butter and blueberries.", "Lunch: Kale and white bean salad with olive oil and walnuts.", "Snack: Strawberries.", "Dinner: Grilled chicken, farro, sautéed spinach with garlic."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["fried", "trans_fat", "sweetened_beverage", "ultra_processed"], limitTags: ["butter", "aged_cheese", "high_fat_dairy", "red_meat", "added_sugar", "refined_grain"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["Rush University MIND diet research", "NIH National Institute on Aging"], sortOrder: 17,
  },
  {
    slug: "gerd_reflux",
    name: "GERD / reflux",
    summary: "Smaller meals and fewer trigger foods (fried, fatty, spicy, acidic, chocolate, mint, coffee, alcohol, fizzy drinks) to reduce heartburn.",
    complexity: "simple",
    ruleSheet: [
      "Eat smaller meals more often and stop eating two to three hours before lying down.",
      "Common triggers to cut back: fried and fatty foods, spicy food, tomato and citrus, chocolate, peppermint, coffee and other caffeine, carbonated drinks, alcohol, onion and garlic.",
      "Lean protein, oatmeal, bananas, melon, root vegetables, green vegetables, ginger and whole grains are usually well tolerated.",
      "Keep a note of which foods bother you; triggers vary by person.",
      "Raise the head of your bed and avoid tight waistbands.",
    ],
    sampleDay: ["Breakfast: Oatmeal with banana and a splash of low-fat milk.", "Lunch: Turkey and avocado on whole-grain bread, baby carrots.", "Snack: Melon.", "Dinner: Baked chicken, roasted sweet potato, steamed green beans, ginger tea."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["fried", "spicy", "acidic", "citrus", "tomato", "chocolate", "mint", "coffee", "carbonated", "alcohol", "beer"], limitTags: ["high_fat", "caffeine", "high_fat_dairy", "butter"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["American College of Gastroenterology GERD guideline", "NIH/NIDDK eating, diet and nutrition for GER and GERD"], sortOrder: 18,
  },
  {
    slug: "portfolio",
    name: "Portfolio",
    summary: "A plant-forward plan built around four cholesterol-lowering food groups: nuts, plant protein (soy and legumes), viscous fiber (oats, barley, okra, eggplant) and plant sterols.",
    complexity: "moderate",
    ruleSheet: [
      "Daily targets: about 45 g of nuts, 50 g of plant protein (soy, beans, lentils), 20 g of viscous fiber (oats, barley, psyllium, okra, eggplant, apples, citrus) and 2 g of plant sterols (fortified spreads or supplements).",
      "Mostly plant-based; keep saturated fat low by limiting red meat, butter and full-fat dairy. Fish and poultry in small amounts if desired.",
      "Choose whole grains and lots of vegetables and fruit.",
      "Monounsaturated fats (olive and canola oil, avocado) rather than butter.",
    ],
    sampleDay: ["Breakfast: Oat bran porridge with soy milk, almonds and berries.", "Lunch: Tofu and vegetable stir-fry over barley.", "Snack: Apple with sterol-fortified spread on oat crackers.", "Dinner: Lentil and eggplant stew, side salad with olive oil."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["processed_meat", "trans_fat", "sweetened_beverage", "fried"], limitTags: ["red_meat", "pork", "butter", "high_fat_dairy", "aged_cheese", "egg", "added_sugar", "refined_grain"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["Canadian Cardiovascular Society dyslipidemia guideline (Portfolio diet)", "American Heart Association science advisory on the Portfolio diet (2023)"], sortOrder: 19,
  },
  {
    slug: "nordic",
    name: "Nordic",
    summary: "The Mediterranean idea with northern foods: rye and oats, root vegetables, cabbage, berries, apples, oily fish, rapeseed oil and game or poultry.",
    complexity: "simple",
    ruleSheet: [
      "Whole grains, especially rye, oats and barley, every day.",
      "Plenty of vegetables (roots, cabbage family, legumes), fruit and berries.",
      "Fish and seafood two to three times a week; poultry and game over red meat.",
      "Rapeseed (canola) oil as the main fat; low-fat dairy in moderation.",
      "Limit added sugar, processed meat, salt and ultra-processed food.",
    ],
    sampleDay: ["Breakfast: Oat porridge with lingonberries or blueberries and skyr.", "Lunch: Open-faced rye sandwich with smoked salmon, cucumber and dill.", "Snack: Apple and hazelnuts.", "Dinner: Baked cod, roasted root vegetables, braised red cabbage."],
    oversightNote: false, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["processed_meat", "ultra_processed", "sweetened_beverage", "trans_fat"], limitTags: ["red_meat", "added_sugar", "refined_grain", "high_sodium", "alcohol"] },
    evidenceStrength: "moderate", supervisionLevel: "none", sources: ["Nordic Nutrition Recommendations 2023", "Nordic Council of Ministers New Nordic Diet"], sortOrder: 20,
  },
  {
    slug: "low_purine",
    name: "Low-purine",
    summary: "Fewer purine-rich foods (organ meats, some seafood, beer) and more water, dairy, vegetables and whole grains.",
    complexity: "moderate",
    ruleSheet: [
      "Avoid organ meats (liver, kidney, sweetbreads), anchovies, sardines, herring, mussels, scallops, meat extracts and gravies, and beer.",
      "Limit red meat, pork, lamb and other seafood to small portions a few times a week.",
      "Avoid sugary drinks and foods sweetened with high-fructose corn syrup; limit other alcohol.",
      "Eat freely: vegetables (including the ones once thought risky, like spinach and asparagus), fruit, whole grains, legumes in moderation, low-fat dairy, eggs, nuts, coffee.",
      "Drink plenty of water through the day. Steady, gradual weight loss helps; crash dieting does not.",
    ],
    sampleDay: ["Breakfast: Low-fat yogurt with cherries and granola.", "Lunch: Vegetable and white bean soup, whole-grain roll.", "Snack: Pear and a few walnuts.", "Dinner: Grilled chicken breast (small portion), brown rice, roasted vegetables; water with lemon."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["high_purine", "organ_meat", "beer", "sweetened_beverage"], limitTags: ["red_meat", "pork", "shellfish", "oily_fish", "alcohol", "added_sugar"] },
    evidenceStrength: "moderate", supervisionLevel: "recommended", sources: ["American College of Rheumatology gout management guideline (2020)", "NIH/NIAMS gout resources"], sortOrder: 21,
  },
  {
    slug: "low_oxalate",
    name: "Low-oxalate",
    summary: "Less of the highest-oxalate foods (spinach, rhubarb, almonds, beets, some beans) with calcium at meals and plenty of fluid.",
    complexity: "moderate",
    ruleSheet: [
      "Avoid the highest-oxalate foods: spinach, rhubarb, Swiss chard, beets and beet greens, almonds, cashews, peanuts, sesame, buckwheat, navy and soy beans, sweet potato in large amounts, chocolate in large amounts.",
      "Eat calcium-containing food with meals (dairy or fortified alternatives) so oxalate binds in the gut rather than the kidney.",
      "Drink enough fluid that urine stays pale, usually 2.5 to 3 liters a day.",
      "Keep sodium and animal protein moderate; vegetables and fruit otherwise unrestricted (kale, cabbage, cauliflower, cucumber, apples, melon, berries are low).",
      "Do not take high-dose vitamin C supplements.",
    ],
    sampleDay: ["Breakfast: Eggs with mushrooms, white toast with butter, milk.", "Lunch: Chicken salad with cucumber, lettuce and cheese; grapes.", "Snack: Yogurt and melon.", "Dinner: Baked fish, white rice, roasted cauliflower and green beans."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["high_oxalate"], limitTags: ["tree_nut", "peanut", "sesame", "soy", "chocolate", "high_sodium", "starchy_vegetable"] },
    evidenceStrength: "moderate", supervisionLevel: "recommended", sources: ["American Urological Association medical management of kidney stones guideline", "NIH/NIDDK eating, diet and nutrition for kidney stones"], sortOrder: 22,
  },
  {
    slug: "aip",
    name: "AIP (autoimmune protocol)",
    summary: "A stricter version of Paleo that also removes eggs, nightshades, nuts, seeds and other common irritants for a time, then reintroduces them one by one.",
    complexity: "advanced",
    ruleSheet: [
      "Elimination phase (typically 30 to 90 days): eat meat, poultry, fish, shellfish, organ meats, non-nightshade vegetables, fruit in moderation, coconut, olive oil, avocado, bone broth, fermented vegetables, herbs (non-seed).",
      "Remove grains, legumes, dairy, eggs, nuts, seeds (including coffee, cocoa and seed spices), nightshades (tomato, potato, pepper, eggplant), alcohol, added sugar, sweeteners, food additives, NSAIDs where possible.",
      "Reintroduction: one food at a time in increasing amounts over five to seven days, recording symptoms.",
      "Because so much is removed, work with your care team on protein, calcium and overall calories, and do not stay in elimination longer than needed.",
      "Not appropriate during pregnancy or breastfeeding, or with a history of disordered eating.",
    ],
    sampleDay: ["Breakfast: Turkey and sweet potato hash with sautéed kale.", "Lunch: Chicken soup with carrots, celery, zucchini and bone broth.", "Snack: Coconut yogurt with blueberries.", "Dinner: Grilled salmon, mashed cauliflower, roasted Brussels sprouts with olive oil."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: ["eating_disorder"],
    fitRules: { mode: "exclude", excludeTags: [...GRAINS, "legume", "soy", "peanut", ...DAIRY, "egg", "raw_egg", "tree_nut", "seed", "sesame", "nightshade", "tomato", ...SUGARS, "sweetener", "alcohol", "beer", "coffee", "chocolate", "artificial_additive", "ultra_processed", "seed_oil", "trans_fat", "processed_meat"], limitTags: ["fruit", "high_sugar_fruit", "honey"] },
    evidenceStrength: "limited", supervisionLevel: "required", sources: ["Scripps Research AIP pilot studies (IBD, Hashimoto's)", "Academy of Nutrition and Dietetics commentary on elimination diets"], sortOrder: 23,
  },
  {
    slug: "guided_elimination",
    name: "Guided elimination",
    summary: "Remove the most common food triggers (gluten, dairy, soy, eggs, corn, peanuts, tree nuts, shellfish, added sugar, alcohol) for a few weeks, then test them back one at a time.",
    complexity: "advanced",
    ruleSheet: [
      "Elimination phase (3 to 4 weeks): no gluten, dairy, soy, eggs, corn, peanuts, tree nuts, shellfish, added sugar or alcohol.",
      "Eat: meat, poultry, fish, rice, quinoa, oats labeled gluten-free, legumes other than soy and peanuts, vegetables, fruit, olive oil, seeds.",
      "Keep a daily symptom diary (energy, digestion, skin, sleep, mood).",
      "Reintroduction: one food group every three days in normal portions; stop and note any reaction before moving on.",
      "Keep out only what clearly caused symptoms; everything else comes back. Do not stay eliminated indefinitely.",
      "Not appropriate during pregnancy or breastfeeding, or with a history of disordered eating.",
    ],
    sampleDay: ["Breakfast: Gluten-free oats with sunflower seeds and blueberries.", "Lunch: Grilled chicken, quinoa, roasted vegetables with olive oil.", "Snack: Pear and pumpkin seeds.", "Dinner: Baked salmon, brown rice, steamed broccoli."],
    oversightNote: true, pregnancyBlocked: true, screeningQuestions: ["eating_disorder", "pregnancy"],
    fitRules: { mode: "exclude", excludeTags: ["gluten", "wheat", ...DAIRY, "soy", "egg", "raw_egg", "corn", "peanut", "tree_nut", "shellfish", ...SUGARS, "sweetener", "alcohol", "beer", "ultra_processed", "artificial_additive"] },
    evidenceStrength: "limited", supervisionLevel: "recommended", sources: ["Academy of Nutrition and Dietetics, elimination diets in practice", "American Academy of Allergy, Asthma & Immunology guidance on diagnosing food intolerance"], sortOrder: 24,
  },
  {
    slug: "low_histamine",
    name: "Low-histamine",
    summary: "Fresh food cooked and eaten promptly, with fewer aged, fermented, cured and leftover foods that are high in histamine.",
    complexity: "advanced",
    ruleSheet: [
      "Avoid aged and fermented foods: aged cheese, cured and smoked meat, sauerkraut, kimchi, soy sauce, vinegar, yogurt, kombucha, alcohol (especially wine and beer).",
      "Avoid canned, smoked or leftover fish; eat fish very fresh or frozen-at-sea.",
      "Common plant triggers: tomato, spinach, eggplant, avocado, citrus, strawberries, bananas, pineapple, dried fruit, chocolate, nuts.",
      "Eat freshly cooked meat and poultry, most fresh vegetables, apples, pears, melon, blueberries, rice, quinoa, oats, eggs (cooked), olive oil, fresh herbs.",
      "Cook fresh and freeze leftovers right away; histamine rises as food sits.",
      "Work with your care team; this plan is diagnostic and short-term, and symptoms can have other causes.",
    ],
    sampleDay: ["Breakfast: Oatmeal with pear and a drizzle of maple syrup.", "Lunch: Freshly cooked chicken with rice and steamed zucchini.", "Snack: Apple slices and rice cakes.", "Dinner: Fresh-cooked turkey patties, mashed sweet potato, green beans."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: ["high_histamine", "fermented", "aged_cheese", "processed_meat", "leftover", "alcohol", "beer", "tomato", "citrus", "chocolate", "artificial_additive"], limitTags: ["tree_nut", "peanut", "fish", "oily_fish", "shellfish", "nightshade", "high_sugar_fruit"] },
    evidenceStrength: "limited", supervisionLevel: "recommended", sources: ["Swiss Interest Group Histamine Intolerance food lists", "Academy of Nutrition and Dietetics commentary on histamine intolerance"], sortOrder: 25,
  },
  {
    slug: "specific_carbohydrate",
    name: "Specific Carbohydrate Diet",
    summary: "Only simple carbohydrates (monosaccharides) from fruit, honey, non-starchy vegetables and properly fermented yogurt; no grains, starches, lactose or sucrose.",
    complexity: "advanced",
    ruleSheet: [
      "Allowed: fresh meat, poultry, fish, eggs, non-starchy vegetables, most fruit, nuts and nut flours, honey, 24-hour home-fermented yogurt, aged natural cheeses, dry wine in small amounts, oils and butter.",
      "Not allowed: all grains (wheat, rice, corn, oats), potatoes, yams, sugar and syrups other than honey, milk and most commercial dairy, soy, canned vegetables, processed meats, chocolate, most packaged foods with additives.",
      "Legumes (lentils, split peas, navy beans) only after the first months and soaked overnight.",
      "Start with the introductory phase (broths, well-cooked foods) for a few days and widen slowly as tolerated.",
      "Because the plan is strict, your care team may want to watch weight, fiber and micronutrients.",
    ],
    sampleDay: ["Breakfast: Eggs with sautéed spinach and homemade SCD yogurt with honey.", "Lunch: Chicken salad with avocado and cucumber over greens.", "Snack: Almond-flour muffin and grapes.", "Dinner: Roast beef, butternut squash purée, green beans with butter."],
    oversightNote: true, pregnancyBlocked: false, screeningQuestions: [],
    fitRules: { mode: "exclude", excludeTags: [...GRAINS, "starchy_vegetable", "added_sugar", "sweetened_beverage", "sweetener", "milk", "lactose", "soy", "processed_meat", "chocolate", "artificial_additive", "ultra_processed"], limitTags: ["legume", "alcohol"] },
    evidenceStrength: "limited", supervisionLevel: "recommended", sources: ["Breaking the Vicious Cycle (Gottschall) legal/illegal food list", "Crohn's & Colitis Foundation diet resources", "Nutrition Therapy for IBD (NIMBUS) studies"], sortOrder: 26,
  },
];

export const DIET_BY_SLUG: ReadonlyMap<string, DietCatalogEntry> = new Map(DIET_CATALOG.map((entry) => [entry.slug, entry]));
export const SELECTABLE_DIET_COUNT = 26;
