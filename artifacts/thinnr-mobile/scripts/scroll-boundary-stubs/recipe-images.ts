/**
 * The real screens are rendered for their scroll host contract, not their
 * binary artwork.  Keeping image references as plain objects avoids asking
 * Node to parse Metro's JPG require() calls.
 */
export const RECIPE_IMAGES: Record<string, { uri: string }> = {};
export const HOME_HERO_IMAGE = { uri: 'scroll-boundary-test:home-hero' };
