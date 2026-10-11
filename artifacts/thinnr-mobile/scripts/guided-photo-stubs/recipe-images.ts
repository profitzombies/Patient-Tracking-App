/**
 * Node stand-in for data/recipe-images (static .jpg require()s). The
 * Progress screen looks seed photos up by id; a Proxy hands back a
 * recognizable sentinel for any key.
 */
function sentinelMap(prefix: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, key) => ({ testUri: `${prefix}-${String(key)}` }),
      has: () => true,
    },
  );
}

export const RECIPE_IMAGES = sentinelMap('recipe') as Record<string, never>;
export const HOME_HERO_IMAGE = { testUri: 'home-hero' } as never;
