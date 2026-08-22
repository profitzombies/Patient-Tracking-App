import type { Href } from 'expo-router';

/**
 * Where every "Approved list" entry point (home-hero chip, restaurant-guide
 * footer) sends the patient: the food library's dedicated Approved Foods
 * screen (app/approved-foods.tsx), same destination the Library tab's own
 * "Approved Foods" button pushes. Keep this constant as the single place to
 * retarget if that entry point ever changes.
 */
export const APPROVED_FOODS_HREF: Href = '/approved-foods';
