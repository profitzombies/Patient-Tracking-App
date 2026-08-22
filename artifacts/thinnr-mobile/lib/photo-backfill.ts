/**
 * Coordination for the AI-suggestion photo race.
 *
 * A patient may press "Save recipe" or "Save as custom food" while the dish
 * photo is still generating — or after generation failed, before a
 * successful retry. Blocking saves on a slow image model would be worse, so
 * saves proceed immediately and this tracker guarantees the photo still
 * lands: it remembers what got saved photo-less and patches the photo onto
 * those records the moment generation succeeds (even if the patient has
 * already left the screen — the sinks write through the app-level store).
 *
 * Framework-free on purpose: scripts/verify-photo-backfill.ts regression
 * tests every ordering of the race against this exact module.
 */

export interface PhotoBackfillSinks {
  setRecipePhoto: (id: string, photoUri: string) => void | Promise<void>;
  setFoodPhoto: (id: string, photoUri: string) => void | Promise<void>;
}

export interface PhotoBackfill {
  /** Uri to embed in a save payload right now, if generation already succeeded. */
  photoUri: () => string | undefined;
  /** Call after persisting a recipe so a later photo can be patched onto it. */
  recordRecipeSaved: (id: string) => void;
  /** Call after persisting a custom food so a later photo can be patched onto it. */
  recordFoodSaved: (id: string) => void;
  /** Call on successful generation; backfills every record saved photo-less. */
  photoReady: (uri: string) => void;
}

export function createPhotoBackfill(
  sinks: PhotoBackfillSinks,
  initialUri?: string,
): PhotoBackfill {
  let uri = initialUri;
  let recipeId: string | undefined;
  let foodId: string | undefined;

  const patch = (fn: (id: string, photoUri: string) => void | Promise<void>, id: string, next: string) => {
    Promise.resolve(fn(id, next)).catch(error => {
      console.error('Photo backfill failed', error);
    });
  };

  return {
    photoUri: () => uri,
    // Both record* and photoReady patch, so the photo lands under EVERY
    // interleaving — including the narrow one where the save handler read
    // photoUri() (absent), the photo resolved during the awaited
    // persistence, and only then was the id recorded. Re-patching a record
    // that already embeds the same uri is an idempotent write.
    recordRecipeSaved: id => {
      recipeId = id;
      if (uri) patch(sinks.setRecipePhoto, id, uri);
    },
    recordFoodSaved: id => {
      foodId = id;
      if (uri) patch(sinks.setFoodPhoto, id, uri);
    },
    photoReady: next => {
      uri = next;
      if (recipeId) patch(sinks.setRecipePhoto, recipeId, next);
      if (foodId) patch(sinks.setFoodPhoto, foodId, next);
    },
  };
}
