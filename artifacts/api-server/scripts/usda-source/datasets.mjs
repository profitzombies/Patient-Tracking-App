/** Pinned official releases; downloads remain outside git and the mobile bundle. */
export const DATASETS = Object.freeze({
  'sr-legacy-2018-04': {
    dataset: 'sr_legacy', version: '2018-04', rootKey: 'SRLegacyFoods', dataType: 'SR Legacy',
    sourceUrl: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
    filename: 'FoodData_Central_sr_legacy_food_json_2018-04.json',
  },
  'fndds-2021-2023': {
    dataset: 'fndds', version: '2021-2023', rootKey: 'SurveyFoods', dataType: 'Survey (FNDDS)',
    sourceUrl: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
    filename: 'surveyDownload.json',
  },
  'foundation-2026-04': {
    dataset: 'foundation', version: '2026-04', rootKey: 'FoundationFoods', dataType: 'Foundation',
    // The official April 2026 archive contains 32 null array placeholders.
    // Preserve their positions in the manifest; they are not food records.
    allowNullRecords: true,
    sourceUrl: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
    filename: 'FoodData_Central_foundation_food_json_2026-04-30.json',
  },
});