import { useEffect, useMemo, useState } from 'react';
import type { FoodItem } from '@/data/patient-data';
import { isApprovedFood } from '@/data/approved-foods';
import {
  searchFoodCatalog,
  type CatalogFood,
  type CatalogSearchResult,
} from '@/lib/food-catalog';

const DEBOUNCE_MS = 300;
const EMPTY_REMOTE: CatalogSearchResult = {
  common: [],
  personal: [],
  branded: [],
  upstreamUnavailable: false,
};

export function localCatalogMatches(
  foods: FoodItem[],
  customIds: ReadonlySet<string>,
  query: string,
  approvedOnly: boolean,
): CatalogSearchResult {
  const q = query.trim().toLowerCase();
  const result: CatalogSearchResult = { ...EMPTY_REMOTE, common: [], personal: [], branded: [] };
  if (!q) return result;
  for (const food of foods) {
    const approved = food.catalogApproved ?? isApprovedFood(food.id);
    if (approvedOnly && !approved) continue;
    if (!`${food.name} ${food.brand ?? ''} ${food.category}`.toLowerCase().includes(q)) continue;
    const personal = customIds.has(food.id);
    const group = personal ? 'personal' : food.category === 'Branded Products' ? 'branded' : 'common';
    const item: CatalogFood = {
      ...food,
      catalogId: food.id,
      group,
      source: personal ? 'personal' : food.catalogShared ? 'catalog' : 'thinnr',
      sourceLabel: personal ? 'My Foods' : food.catalogSourceLabel ?? 'THINNR food library',
      approved,
      measures: food.catalogMeasures ?? [],
      ...(food.catalogServingGrams ? { servingGrams: food.catalogServingGrams } : {}),
      ...(food.catalogCanonicalName ? { canonicalName: food.catalogCanonicalName } : {}),
      ...(food.catalogLookupId ? { lookupId: food.catalogLookupId } : {}),
    };
    result[group].push(item);
  }
  return result;
}

/** Exported to lock the local snapshot + remote search identity invariant. */
export function mergeCatalogResults(local: CatalogFood[], remote: CatalogFood[]): CatalogFood[] {
  const seen = new Set(local.flatMap(item => [item.catalogId, item.lookupId].filter(Boolean)));
  return [...local, ...remote.filter(item => !seen.has(item.catalogId) && !seen.has(item.lookupId))];
}

export interface FoodCatalogSearchState extends CatalogSearchResult {
  loading: boolean;
  remoteAttempted: boolean;
  error?: string;
}

/** The API remains the authority on whether a query is specific enough for OFF. */
export function includeBrandedFallback(approvedOnly: boolean): boolean {
  return !approvedOnly;
}

export function useFoodCatalogSearch(
  foods: FoodItem[],
  customFoods: FoodItem[],
  query: string,
  approvedOnly = false,
): FoodCatalogSearchState {
  const customIds = useMemo(() => new Set(customFoods.map(food => food.id)), [customFoods]);
  const local = useMemo(
    () => localCatalogMatches(foods, customIds, query, approvedOnly),
    [foods, customIds, query, approvedOnly],
  );
  const [remote, setRemote] = useState<CatalogSearchResult>(EMPTY_REMOTE);
  const [remoteKey, setRemoteKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [remoteAttempted, setRemoteAttempted] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const trimmed = query.trim();
    setError(undefined);
    setRemoteAttempted(false);
    if (trimmed.length < 2) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void searchFoodCatalog(trimmed, {
        approvedOnly,
        // Ask for branded results in normal search; the API's stricter query
        // threshold still rejects stale or overly broad Open Food Facts work.
        includeBranded: includeBrandedFallback(approvedOnly),
        signal: controller.signal,
      }).then(result => {
        if (controller.signal.aborted) return;
        setRemote(result);
        setRemoteKey(`${trimmed}\0${approvedOnly}`);
        setRemoteAttempted(true);
        setLoading(false);
      }).catch(reason => {
        if (controller.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) return;
        setError(reason instanceof Error ? reason.message : 'Shared foods are unavailable.');
        setRemoteAttempted(true);
        setLoading(false);
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, approvedOnly]);

  const currentRemote =
    remoteKey === `${query.trim()}\0${approvedOnly}` ? remote : EMPTY_REMOTE;
  return {
    common: mergeCatalogResults(local.common, currentRemote.common),
    personal: mergeCatalogResults(local.personal, currentRemote.personal),
    branded: approvedOnly ? [] : currentRemote.branded,
    upstreamUnavailable: currentRemote.upstreamUnavailable,
    ...(currentRemote.message ? { message: currentRemote.message } : {}),
    loading,
    remoteAttempted,
    ...(error ? { error } : {}),
  };
}