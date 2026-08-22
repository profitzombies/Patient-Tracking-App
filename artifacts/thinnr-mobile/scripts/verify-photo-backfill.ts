/**
 * AI-suggestion photo backfill regression check.
 *
 * Guards the save-vs-photo race on the AI recipe preview: a patient can save
 * a suggestion while its dish photo is still generating, or after a failed
 * attempt before a successful retry. These scenarios prove the saved recipe
 * and custom food always end up with the generated photo URI, no matter
 * which side of the race finishes first.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:photo-backfill
 */
import { createPhotoBackfill } from '../lib/photo-backfill';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean) {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

interface Stored {
  id: string;
  photoUri?: string;
}

/** In-memory stand-in for the persisted patient store the screen writes to. */
function makeStore() {
  const recipes = new Map<string, Stored>();
  const foods = new Map<string, Stored>();
  let seq = 0;
  return {
    recipes,
    foods,
    // Mirrors the screen's save handlers: embed the uri only when available.
    saveRecipe(photoUri?: string): Stored {
      const rec: Stored = { id: `airec_${++seq}`, ...(photoUri ? { photoUri } : {}) };
      recipes.set(rec.id, rec);
      return rec;
    },
    saveFood(photoUri?: string): Stored {
      const rec: Stored = { id: `custom_${++seq}`, ...(photoUri ? { photoUri } : {}) };
      foods.set(rec.id, rec);
      return rec;
    },
    sinks: {
      setRecipePhoto(id: string, uri: string) {
        const rec = recipes.get(id);
        if (rec) rec.photoUri = uri;
      },
      setFoodPhoto(id: string, uri: string) {
        const rec = foods.get(id);
        if (rec) rec.photoUri = uri;
      },
    },
  };
}

const URI = 'data:image/jpeg;base64,GENERATED';

// 1. Save recipe AND custom food while the photo request is still pending.
{
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks);
  check('pending: no uri to embed at save time', tracker.photoUri() === undefined);
  const recipe = store.saveRecipe(tracker.photoUri());
  tracker.recordRecipeSaved(recipe.id);
  const food = store.saveFood(tracker.photoUri());
  tracker.recordFoodSaved(food.id);
  check('pending: recipe stored photo-less before generation resolves', recipe.photoUri === undefined);
  tracker.photoReady(URI);
  check('pending: saved recipe backfilled with generated uri', store.recipes.get(recipe.id)?.photoUri === URI);
  check('pending: saved custom food backfilled with generated uri', store.foods.get(food.id)?.photoUri === URI);
}

// 2. Photo finishes first; the save embeds the uri directly.
{
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks);
  tracker.photoReady(URI);
  check('ready-first: uri available for the save payload', tracker.photoUri() === URI);
  const recipe = store.saveRecipe(tracker.photoUri());
  tracker.recordRecipeSaved(recipe.id);
  check('ready-first: recipe embeds uri at save time', store.recipes.get(recipe.id)?.photoUri === URI);
}

// 3. Photo cached from an earlier visit (registry) seeds the tracker.
{
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks, 'CACHED');
  check('cached: initial uri surfaces immediately', tracker.photoUri() === 'CACHED');
}

// 4. Generation failed, patient saves anyway, a later retry succeeds.
{
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks);
  const food = store.saveFood(tracker.photoUri());
  tracker.recordFoodSaved(food.id);
  check('retry: food saved photo-less after a failed generation', food.photoUri === undefined);
  tracker.photoReady(URI);
  check('retry: food backfilled after the successful retry', store.foods.get(food.id)?.photoUri === URI);
}

// 5. Photo resolves with nothing saved — no writes happen.
{
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks);
  tracker.photoReady(URI);
  check('no-saves: stores untouched', store.recipes.size === 0 && store.foods.size === 0);
}

// 6. Interleaving: the photo resolves DURING the awaited save persistence —
//    after the save handler read photoUri() (absent), before record*Saved
//    ran. The record must still end up with the photo.
{
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks);
  const uriAtSaveTime = tracker.photoUri(); // undefined — save started pre-photo
  const recipe = store.saveRecipe(uriAtSaveTime);
  const food = store.saveFood(uriAtSaveTime);
  tracker.photoReady(URI); // lands mid-await, before the ids are recorded
  tracker.recordRecipeSaved(recipe.id);
  tracker.recordFoodSaved(food.id);
  check('interleaved: recipe patched when recorded after photoReady', store.recipes.get(recipe.id)?.photoUri === URI);
  check('interleaved: food patched when recorded after photoReady', store.foods.get(food.id)?.photoUri === URI);
}

// 7. Same interleaving with real async timing, mirroring the screen's save
//    handler shape: read uri → await persistence → record id.
async function asyncInterleavingScenario() {
  const store = makeStore();
  const tracker = createPhotoBackfill(store.sinks);
  const pendingSave = (async () => {
    const uriNow = tracker.photoUri();
    await new Promise(resolve => setTimeout(resolve, 20)); // persistence in flight
    const recipe = store.saveRecipe(uriNow);
    tracker.recordRecipeSaved(recipe.id);
    return recipe;
  })();
  await new Promise(resolve => setTimeout(resolve, 5));
  tracker.photoReady(URI); // photo lands during the save's await
  const recipe = await pendingSave;
  check('async-interleaved: recipe still ends with the photo', store.recipes.get(recipe.id)?.photoUri === URI);
}

// 8. Only one of the two save kinds used — the other sink never fires.
{
  const store = makeStore();
  let foodSinkCalls = 0;
  const tracker = createPhotoBackfill({
    setRecipePhoto: store.sinks.setRecipePhoto,
    setFoodPhoto: (id, uri) => {
      foodSinkCalls += 1;
      store.sinks.setFoodPhoto(id, uri);
    },
  });
  const recipe = store.saveRecipe(tracker.photoUri());
  tracker.recordRecipeSaved(recipe.id);
  tracker.photoReady(URI);
  check('recipe-only: recipe backfilled', store.recipes.get(recipe.id)?.photoUri === URI);
  check('recipe-only: food sink never called', foodSinkCalls === 0);
}

asyncInterleavingScenario()
  .then(() => {
    if (failures > 0) {
      console.error(`\nphoto-backfill: ${failures}/${checks} checks FAILED`);
      process.exit(1);
    }
    console.log(`photo-backfill: all ${checks} checks passed`);
  })
  .catch(error => {
    console.error('photo-backfill: scenario crashed', error);
    process.exit(1);
  });
