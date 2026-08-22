/**
 * Static image maps for the patient experience. Metro requires literal
 * require() calls, so these are enumerated by hand and keyed by id.
 */
import type { ImageSourcePropType } from 'react-native';

export const RECIPE_IMAGES: Record<string, ImageSourcePropType> = {
  rec_yogurt_bowl: require('@/assets/images/recipes/greek-yogurt-bowl.jpg'),
  rec_egg_scramble: require('@/assets/images/recipes/egg-white-scramble.jpg'),
  rec_overnight_oats: require('@/assets/images/recipes/overnight-oats.jpg'),
  rec_avocado_toast: require('@/assets/images/recipes/avocado-toast.jpg'),
  rec_cottage_parfait: require('@/assets/images/recipes/cottage-cheese-parfait.jpg'),
  rec_cobb_salad: require('@/assets/images/recipes/chicken-cobb-salad.jpg'),
  rec_quinoa_bowl: require('@/assets/images/recipes/turkey-quinoa-bowl.jpg'),
  rec_tuna_wrap: require('@/assets/images/recipes/tuna-wrap.jpg'),
  rec_lentil_soup: require('@/assets/images/recipes/lentil-soup.jpg'),
  rec_shrimp_zoodles: require('@/assets/images/recipes/shrimp-zoodles.jpg'),
  rec_baked_salmon: require('@/assets/images/recipes/baked-salmon.jpg'),
  rec_roast_chicken: require('@/assets/images/recipes/roast-chicken.jpg'),
  rec_turkey_meatballs: require('@/assets/images/recipes/turkey-meatballs.jpg'),
  rec_seared_cod: require('@/assets/images/recipes/seared-cod.jpg'),
  rec_beef_stirfry: require('@/assets/images/recipes/beef-stirfry.jpg'),
  rec_energy_bites: require('@/assets/images/recipes/energy-bites.jpg'),
  rec_cucumber_hummus: require('@/assets/images/recipes/cucumber-hummus.jpg'),
  rec_apple_almond: require('@/assets/images/recipes/apple-almond-butter.jpg'),
  rec_boiled_eggs: require('@/assets/images/recipes/boiled-eggs.jpg'),
  rec_protein_smoothie: require('@/assets/images/recipes/protein-smoothie.jpg'),
};

/** Full-bleed illustrated hero for the patient home (Today) screen. */
export const HOME_HERO_IMAGE: ImageSourcePropType = require('@/assets/images/patient/home-hero.jpg');

export const PROGRESS_IMAGES: Record<string, ImageSourcePropType> = {
  photo_baseline: require('@/assets/images/progress/baseline.jpg'),
  photo_week2: require('@/assets/images/progress/week-2.jpg'),
  photo_week4: require('@/assets/images/progress/week-4.jpg'),
  photo_week6: require('@/assets/images/progress/week-6.jpg'),
};
