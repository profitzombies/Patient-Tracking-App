/**
 * THINNR program instructions — verbatim content module.
 *
 * Every program-text string in this file is quoted character-for-character
 * from the official archive:
 *   - docs/thinnr-program/program-instructions.md (PDF pages 4–9)
 *   - docs/thinnr-program/manual-transcription.md (PDF page 2, Welcome)
 *
 * Do NOT edit, paraphrase, spell-"fix", or reorder these strings — apparent
 * typos and oddities ("The Thinner homeopathic medication", "ofsystemic",
 * "UNLESS is it", the stray period in "Nutrition Strategy. Approved
 * Selections") are present in the source manual and must be preserved.
 * The only transforms applied here are joining the PDF's hard line breaks
 * with single spaces and resolving its two end-of-line hyphenations
 * ("de-/signed" → "designed", "science-/backed" → "science-backed").
 * Book-referential sentences (e.g. "…at the back of this book") are omitted
 * whole, never rewritten. See docs/thinnr-program/README.md.
 *
 * Short UI labels (stat-tile labels, "Days 1-2", short phase names) are
 * neutral chrome, not program text.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProgramPhaseId = 'activation' | 'thinning' | 'transition' | 'normalization';

export interface PhaseStat {
  /** Exact number/value from the manual */
  value: string;
  /** Neutral short label (UI chrome) */
  label: string;
}

export interface PhaseCallout {
  /** Verbatim heading when the manual has one; omitted otherwise */
  title?: string;
  paragraphs: string[];
}

export interface PhaseMeal {
  title: string;
  lines: string[];
}

export interface PhaseMealPlan {
  heading: string;
  intro: string[];
  meals: PhaseMeal[];
}

/** Ordered content blocks — order mirrors the manual exactly. */
export type PhaseBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'callout'; callout: PhaseCallout }
  | { kind: 'mealPlan'; mealPlan: PhaseMealPlan };

export interface ProgramPhase {
  id: ProgramPhaseId;
  /** 1-based position in the program */
  index: number;
  /** Verbatim phase name */
  name: string;
  /** Short UI label */
  shortName: string;
  /** Verbatim day range from the phase header */
  dayRange: string;
  /** Compact UI label */
  dayRangeShort: string;
  startDay: number;
  /** null = open-ended (Day 43 and Beyond) */
  endDay: number | null;
  /** Verbatim "Drop Dosage" line where the manual has one */
  dosage?: string;
  /** Verbatim exercise line where the manual has one */
  exercise?: string;
  stats: PhaseStat[];
  body: PhaseBlock[];
}

// ─── The four phases ─────────────────────────────────────────────────────────

export const PROGRAM_PHASES: ProgramPhase[] = [
  {
    id: 'activation',
    index: 1,
    name: 'Metabolic Activation Phase',
    shortName: 'Activation',
    dayRange: 'Day 1 and Day 2',
    dayRangeShort: 'Days 1-2',
    startDay: 1,
    endDay: 2,
    dosage: 'Drop Dosage: 1mL, 3 times per day',
    stats: [
      { value: '1mL', label: '3x daily' },
      { value: '4,000+', label: 'cal per day' },
      { value: '80-100', label: 'oz water' },
    ],
    body: [
      {
        kind: 'paragraph',
        text: 'The goal of the Metabolic Activation Phase is to stimulate and maintain dietary thermogenesis while the Thinnr homeopathic medicine takes effect in your body. When you transition into the Metabolic Thinning phase, this will help you burn more calories on a daily basis.',
      },
      {
        kind: 'paragraph',
        text: 'During this phase, you should consume at least 4,000 calories per day. It is recommended that you set a target of 70% of your intake be higher fat protein. If you have a history of gallbladder issues or have had your gallbladder removed, consult with your healthcare provider before starting the Metabolic Activation Phase.',
      },
      {
        kind: 'paragraph',
        text: 'It is critical that you \u201cgraze\u201d throughout the day rather than sticking to just two or three meals. Continuous eating is essential, as trying to load with only three meals may result in slower weight loss during the next phase.',
      },
      {
        kind: 'paragraph',
        text: 'You will start drinking 80-100 ounces of water per day. It is important that you spread your water consumption across the day.',
      },
      {
        kind: 'callout',
        callout: {
          title: 'What to Expect During the Metabolic Activation Phase',
          paragraphs: [
            'On days 1 and 2, it\u2019s completely normal to experience a slight weight gain.',
            'For many people, the Metabolic Activation Phase is one of the most enjoyable parts of the program, aside from seeing the pounds melt away later.',
          ],
        },
      },
    ],
  },
  {
    id: 'thinning',
    index: 2,
    name: 'Metabolic Thinning Phase',
    shortName: 'Thinning',
    dayRange: 'Day 3 - Day 39',
    dayRangeShort: 'Days 3-39',
    startDay: 3,
    endDay: 39,
    dosage: 'Drop Dosage: 1mL, 3 times per day',
    exercise:
      'Exercise: Limit exercise to no more than 20 minutes of light to moderate intensity walking or 20 minutes of light yoga.',
    stats: [
      { value: '1mL', label: '3x daily' },
      { value: '2', label: 'meals per day' },
      { value: '80-100', label: 'oz water' },
    ],
    body: [
      {
        kind: 'paragraph',
        text: 'During the Metabolic Thinning phase, you will continue taking 1mL of the Thinnr homeopathic formulation dose 3 times per day and follow the recommended time spacing between doses.',
      },
      {
        kind: 'paragraph',
        text: 'You will also start following the Thinnr Weight Loss & Weight Maintenance Nutrition Strategy, a specific and balanced combination of low-glycemic and anti-inflammatory foods, which is covered in detail below. It is vital that you stick to the prescribed portion sizes\u2014no skipping meals or shifting foods around.',
      },
      {
        kind: 'paragraph',
        text: 'Continue to drink at least 80-100 ounces of water daily, as instructed above.',
      },
      {
        kind: 'callout',
        callout: {
          paragraphs: [
            'It is common for a person to lose 1-3 pounds per day for the first few days as the body begins flushing itself ofsystemic inflammation. On or around day 5, your weight loss will likely slow (depending on how much inflammation is in your body). Moving forward, your weight loss will typically average 0.25 to 0.75 pounds per day. Some individuals may find that their weight loss stalls for 1-2 days. If this happens, continue with the Metabolic Thinning phase as instructed. If your weight loss has stalled for more than 72 hours, please notify your Thinnr healthcare provider and they may make additional recommendations to break your stall.',
          ],
        },
      },
      {
        kind: 'mealPlan',
        mealPlan: {
          heading: 'Metabolic Thinning Phase Nutrition Strategy And Meal Instructions',
          intro: [
            'In addition to the specific and balanced combination of low-glycemic and anti-inflammatory foods, the Thinnr weight loss program utilizes the concepts of intermittent fasting. This means you will eat 2 times per day, and your goal is to eat both meals within a 6 to 7-hour window of time. For example, if you eat your first meal at noon, you will want to ensure you have eaten your second meal by 7:00 PM. We recommend that you eat lunch and dinner so that a large portion of your intermittent fasting is while you sleep. You can still enjoy coffee, water, iced tea, or diet soda, but no added sugar or fats. If you need cream for your coffee, opt for a non-fat, calorie-free version and a sweetener with Stevia instead of sugar. If a food is not on the \u201capproved list\u201d, it is not allowed UNLESS is it specifically called for in a Thinnr-approved recipe.',
            'It is important to vary and rotate your protein, vegetable, and fruit selections for each meal. Basically, avoid eating the same food multiple meals in a row, meaning don\u2019t eat chicken as your protein selection for more than 2 consecutive meals.',
            'To make this easy to understand, we will assume that your first meal will be lunch and your second meal will be dinner. We will also assume that Your first meal will be eaten at noon and your 2nd meal will be consumed at 6:00 PM.',
          ],
          meals: [
            {
              title: 'Breakfast:',
              lines: [
                'No food. Drink coffee, tea, or water. Use no-calorie cream substitutes and/or no-calorie flavorings if you choose. We recommend using Stevia as an alternative to sugar, as adding sugar to your drinks is prohibited.',
              ],
            },
            {
              title: 'Lunch:',
              lines: [
                'Protein: 5-6 oz. of Thinnr Nutrition Strategy-approved lean protein',
                'Vegetables: 5-6 oz. of Thinnr Nutrition Strategy-approved vegetables',
                'Fruit: 5-6 oz. of Thinnr Nutrition Strategy-approved fresh fruit',
                'Bread (optional): Thinnr Nutrition Strategy-approved grain',
              ],
            },
            {
              title: 'Dinner: (Recommended to eat different items than consumed at lunch)',
              lines: [
                'Protein: 5-6 oz. of Thinnr Nutrition Strategy-approved lean protein',
                'Vegetables: 5-6 oz. of Thinnr Nutrition Strategy-approved vegetables',
                'Fruit: 5-6 oz. of Thinnr Nutrition Strategy-approved fresh fruit',
                'Bread (optional): Thinnr Nutrition Strategy-approved grain',
              ],
            },
          ],
        },
      },
    ],
  },
  {
    id: 'transition',
    index: 3,
    name: 'Metabolic Transition Phase',
    shortName: 'Transition',
    dayRange: 'Day 40 \u2013 Day 42',
    dayRangeShort: 'Days 40-42',
    startDay: 40,
    endDay: 42,
    dosage: 'Drop Dosage: No Thinnr formulation',
    stats: [
      { value: 'None', label: 'drop dosage' },
      { value: '2', label: 'meals per day' },
      { value: '80-100', label: 'oz water' },
    ],
    body: [
      {
        kind: 'paragraph',
        text: 'Continue following the Thinnr Metabolic Phase nutrition strategy.',
      },
    ],
  },
  {
    id: 'normalization',
    index: 4,
    name: 'Metabolic Normalization Phase',
    shortName: 'Normalization',
    dayRange: 'Day 43 and Beyond',
    dayRangeShort: 'Day 43+',
    startDay: 43,
    endDay: null,
    stats: [
      { value: 'BMR', label: 'calorie target' },
      { value: '7-8 oz', label: 'per portion' },
      { value: '300-400', label: 'breakfast cal' },
    ],
    body: [
      {
        kind: 'paragraph',
        text: 'The Thinnr Metabolic Normalization Phase distinguishes the Thinnr Weight Loss Program from other programs. It provides easy-to-follow guidelines to help ensure successful long-term weight loss.',
      },
      {
        kind: 'callout',
        callout: {
          paragraphs: [
            'Those who adhere to the Thinnr Metabolic Normalization Phase guidelines will experience more sustained weight loss. This happens because you\u2019ve adjusted your behavioral and eating habits and achieved a new BMI and BMR.',
          ],
        },
      },
      {
        kind: 'paragraph',
        text: 'Additionally, we recommend that you start the Thinnr Weight Loss Maintenance Support Pack which is designed to help sustain your weight loss results.',
      },
      {
        kind: 'paragraph',
        text: 'If you have not reached your weight loss goal during the previous Thinnr phases, follow the Thinnr Metabolic Normalization Phase instructions for at least 28 days before starting your next Thinnr cycle.',
      },
      {
        kind: 'paragraph',
        text: 'Additionally, if you choose to discontinue the intermittent fasting component, you can resume eating breakfast. We recommend setting a target of 300-400 calories composed of a combination of lean protein and/or eggs and fruit from the Nutrition Strategy Approved Selections and plant-based healthy fats like avocado.',
      },
      {
        kind: 'mealPlan',
        mealPlan: {
          heading: 'Metabolic Normalization Phase Nutrition Strategy And Meal Instructions',
          intro: [
            'During the Thinnr Metabolic Normalization Phase, you will increase your caloric intake to match your Basal Metabolic Rate (BMR), which is the number of calories you burn at rest. Additionally, we recommend that you start or resume an exercise routine. When you do this, you should also increase your daily caloric intake by adding 0.5 ounces of lean protein for every 100 calories you burn with the exercise. A high-quality 0-carb protein powder is also acceptable if it is high quality and comes from a clean source.',
          ],
          meals: [
            {
              title: 'Breakfast (Optional):',
              lines: [
                '300-400 calories composed of a combination of lean protein and/or eggs and fruit from the Nutrition Strategy. Approved Selections and plant-based healthy fats like avocado.',
              ],
            },
            {
              title: 'Lunch:',
              lines: [
                'Protein: 7-8 oz. of Thinnr Nutrition Strategy-approved lean protein',
                'Vegetables: 7-8 oz. of Thinnr Nutrition Strategy-approved vegetables',
                'Fruit: 7-8 oz. of Thinnr Nutrition Strategy-approved fresh fruit',
                'Bread (optional): Thinnr Nutrition Strategy-approved grain',
              ],
            },
            {
              title: 'Dinner: (Recommended to eat different items than consumed at lunch)',
              lines: [
                'Protein: 7-8 oz. of Thinnr Nutrition Strategy-approved lean protein',
                'Vegetables: 7-8 oz. of Thinnr Nutrition Strategy-approved vegetables',
                'Fruit: 7-8 oz. of Thinnr Nutrition Strategy-approved fresh fruit',
                'Bread (optional): Thinnr Nutrition Strategy-approved grain',
              ],
            },
          ],
        },
      },
    ],
  },
];

// ─── Shared sections (Welcome, 2 Pillars, 4 Phases, Taking the Formula) ─────

export const WELCOME_SECTION = {
  /** Verbatim heading from manual PDF page 2 */
  heading: 'Welcome to Your Transformation with the Thinnr Weight Loss Protocol!',
  paragraphs: [
    'You\u2019re about to embark on a journey that could change everything! Prepare to see real, fast, lasting results with the Thinnr Weight Loss Protocol \u2014 our revolutionary approach to weight loss that\u2019s designed to bring you closer to the body, confidence, and vitality you\u2019ve been dreaming of!',
    'Got questions? Don\u2019t hesitate! Your Thinnr healthcare provider is just a call away, ready to guide and support you every step of the way.',
  ],
};

export const PILLARS_SECTION = {
  /** Verbatim heading from manual PDF page 4 */
  heading: 'Thinnr\u2122 - The 2 Pillar Approach to Weight Loss & Weight Maintenance',
  intro:
    'The Thinnr Weight Loss Program pillars are the Thinnr Homeopathic Medication and the Thinnr Weight Loss & Weight Maintenance Nutrition Strategy.',
  pillars: [
    {
      title: 'Thinnr Homeopathic Medication',
      text: 'The Thinner homeopathic medication is an all-natural, FDA-registered homeopathic OTC medicine that supports healthy weight loss, a balanced metabolism, lower stress levels, reduced hunger and cravings, detoxification, and improved elimination as part of a comprehensive weight management plan.',
    },
    {
      title: 'Thinnr Weight Loss & Weight Maintenance Nutrition Strategy',
      text: 'The Thinnr Weight Loss & Weight Maintenance Nutrition Strategy is a science-backed nutrition approach emphasizing specific portions and combinations of low glycemic index and anti-inflammatory foods.',
    },
  ],
  outro:
    'This holistic combination promotes sustainable weight loss, reduces inflammation, and supports overall health, making it an ideal solution for long-term weight management and well-being.',
  highlight:
    'The Thinnr program is clinically shown to achieve significant weight loss faster and at a lower cost than GLP-1s. As an added benefit, with Thinnr, there are no prescription drugs, no giving yourself injections, no strenuous exercise, no shakes, and no expensive prepackaged foods.',
};

export const PHASES_SECTION = {
  /** Verbatim heading from manual PDF page 4 */
  heading: 'The 4 Phases Of The Thinnr Weight Loss Program',
  intro:
    'The Thinnr program is divided into 4 phases: the Metabolic Activation Phase, the Metabolic Thinning Phase, the Metabolic Transition Phase, and the Metabolic Normalization Phase.',
};

export const FORMULA_SECTION = {
  /** Verbatim heading from manual PDF page 4 */
  heading: 'Taking the Thinnr Homeopathic Formulation',
  items: [
    'The Thinnr formula is administered sublingually (under the tongue) for maximum absorption. Before taking it, giving the bottle a quick shake is important.',
    'You will start taking the formulation three times a day from days 1-39. You will take 1mL three times per day. On days 40-42, you won\u2019t take the Thinnr medicine.',
    'Try to space the doses about 7 hours apart. A suggested schedule is 8 a.m., 3 p.m., and 10 p.m., but if those times don\u2019t work for you, choose times that fit your schedule. Just make sure the doses are as evenly spaced as possible, around 7 hours apart.',
    'Avoid eating or drinking for 5 minutes before and after taking the formulation.',
    'It\u2019s important that you do not skip doses. Missing doses may leave you feeling hungry, may cause your blood sugar to fluctuate, and can potentially slow your metabolism. If you miss a dose, please take it as soon as possible.',
  ],
};

// ─── Day → phase helpers ─────────────────────────────────────────────────────

/** Highest program day the day → phase helpers accept. */
export const MAX_PROGRAM_DAY = 365;

export function clampProgramDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(MAX_PROGRAM_DAY, Math.max(1, Math.floor(day)));
}

/** The phase a patient is in on a given program day (day 1 = first day). */
export function phaseForDay(day: number): ProgramPhase {
  const d = clampProgramDay(day);
  return (
    PROGRAM_PHASES.find(p => d >= p.startDay && (p.endDay === null || d <= p.endDay)) ??
    PROGRAM_PHASES[PROGRAM_PHASES.length - 1]
  );
}

export function phaseById(id: string | undefined): ProgramPhase | undefined {
  return PROGRAM_PHASES.find(p => p.id === id);
}

/** 'current' | 'completed' | 'upcoming' for a phase relative to a program day. */
export function phaseStatusForDay(
  phase: ProgramPhase,
  day: number,
): 'current' | 'completed' | 'upcoming' {
  const d = clampProgramDay(day);
  if (d < phase.startDay) return 'upcoming';
  if (phase.endDay !== null && d > phase.endDay) return 'completed';
  return 'current';
}
