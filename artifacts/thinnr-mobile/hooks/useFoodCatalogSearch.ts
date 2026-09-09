import { useEffect, useMemo, useRef, useState } from 'react';
import type { FoodItem } from '@/data/patient-data';
import { isApprovedFood } from '@/data/approved-foods';
import {
  searchFoodCatalog,
  type CatalogFood,
  type CatalogSearchResult,
} from '@/lib/food-catalog';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { scaledSnapshotMacros } from '@/data/food-nutrition';

const DEBOUNCE_MS = 300;
const EMPTY_REMOTE: CatalogSearchResult = {
  common: [],
  personal: [],
  branded: [],
  results: [],
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
    const item = foodItemToCatalogFood(food, customIds.has(food.id));
    if (approvedOnly && !item.approved) continue;
    result[item.group].push(item);
  }
  return result;
}

export function foodItemToCatalogFood(food: FoodItem, personal = false): CatalogFood {
    const approved = food.catalogApproved ?? isApprovedFood(food.id);
    const group = personal ? 'personal' : food.category === 'Branded Products' ? 'branded' : 'common';
    const snapshotProvider = food.nutritionSnapshot?.source.provider.toLowerCase();
    const snapshotSource =
      snapshotProvider === 'usda' || snapshotProvider === 'thinnr' ||
      snapshotProvider === 'openfoodfacts' || snapshotProvider === 'personal'
        ? snapshotProvider
        : undefined;
    const totals = food.nutritionSnapshot ? scaledSnapshotMacros(food.nutritionSnapshot) : null;
    return {
      ...food,
      ...(totals ?? {}),
      catalogId: food.id,
      group,
      source: personal ? 'personal' : snapshotSource ?? (food.catalogShared ? 'catalog' : 'thinnr'),
      sourceLabel: personal ? 'My Foods' : food.catalogSourceLabel ?? 'THINNR food library',
      approved,
      measures: food.catalogMeasures ?? [],
      ...(food.catalogServingGrams ? { servingGrams: food.catalogServingGrams } : {}),
      ...(food.catalogCanonicalName ? { canonicalName: food.catalogCanonicalName } : {}),
      ...(food.catalogLookupId ? { lookupId: food.catalogLookupId } : {}),
      ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
      ...(food.nutritionSnapshot?.variant ? {
        familyKey: food.nutritionSnapshot.variant.familyKey,
        variantSummary: food.nutritionSnapshot.variant.summary,
        dimensions: food.nutritionSnapshot.variant.dimensions,
      } : {}),
    };
}

/** Exported to lock the local snapshot + remote search identity invariant. */
export function mergeCatalogResults(local: CatalogFood[], remote: CatalogFood[]): CatalogFood[] {
  const seen = new Set(local.flatMap(item => [item.catalogId, item.lookupId].filter(Boolean)));
  return [...local, ...remote.filter(item => !seen.has(item.catalogId) && !seen.has(item.lookupId))];
}

export function boundedLocalResults(result: CatalogSearchResult, limit = 6): CatalogFood[] {
  const seen = new Set<string>();
  const rows: CatalogFood[] = [];
  for (const food of [...result.personal, ...result.common, ...result.branded]) {
    if (food.group !== 'personal' && !food.nutritionSnapshot && !food.catalogId.startsWith('cfg_')) {
      continue;
    }
    const key = food.familyKey ?? food.resultKey ?? food.lookupId ?? food.catalogId;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      ...food,
      sourceLabel: food.group === 'personal'
        ? 'Saved on this device · My Foods'
        : `Saved on this device · ${food.sourceLabel}`,
    });
    if (rows.length === limit) break;
  }
  return rows;
}

const EXPLICIT_VARIANT_TERMS = [
  'raw', 'cooked', 'roasted', 'grilled', 'fried', 'baked', 'skinless',
  'skin-on', 'meatless', 'whole', 'white', 'dry',
];

/** Applies a saved exact amount only when it cannot contradict typed intent. */
export function applyRememberedFamilyConfigurations(
  results: CatalogFood[],
  rememberedInRecencyOrder: CatalogFood[],
  query: string,
): CatalogFood[] {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const ratio = normalized.match(/\b(\d{2,3})\s*(?:%|\/\s*\d{1,3})/i)?.[1];
  const terms = EXPLICIT_VARIANT_TERMS.filter(term => normalized.includes(term));
  return results.map(result => {
    if (!result.familyKey || result.choiceRequired) return result;
    const remembered = rememberedInRecencyOrder.find(candidate => {
      if (candidate.familyKey !== result.familyKey || !candidate.nutritionSnapshot) return false;
      const evidence = [
        candidate.name,
        candidate.variantSummary ?? '',
        ...Object.values(candidate.dimensions ?? {}),
      ].join(' ').toLowerCase();
      if (ratio && !new RegExp(`\\b${ratio}\\s*(?:%|/|percent|lean)`, 'i').test(evidence)) return false;
      return terms.every(term => evidence.includes(term));
    });
    if (!remembered) return result;
    // Explicit server dimensions remain authoritative. A remembered candidate
    // must agree with every dimension the result already constrained.
    if (ratio || terms.length > 0) {
      const requestedDimensions = result.dimensions ?? {};
      if (Object.entries(requestedDimensions).some(([key, value]) =>
        remembered.dimensions?.[key] !== undefined && remembered.dimensions[key] !== value
      )) return result;
    }
    return remembered;
  });
}

export interface FoodCatalogSearchState extends CatalogSearchResult {
  loading: boolean;
  loadingMore: boolean;
  remoteAttempted: boolean;
  error?: string;
  showMore: () => void;
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
  intent: 'basic' | 'packaged' = 'basic',
  search: typeof searchFoodCatalog = searchFoodCatalog,
): FoodCatalogSearchState {
  const customIds = useMemo(() => new Set(customFoods.map(food => food.id)), [customFoods]);
  const { account } = usePatientAccount();
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;
  const local = useMemo(
    () => localCatalogMatches(foods, customIds, query, approvedOnly),
    [foods, customIds, query, approvedOnly],
  );
  const [state, setState] = useState<{
    key: string;
    remote: CatalogSearchResult;
    loading: boolean;
    loadingMore: boolean;
    remoteAttempted: boolean;
    error?: string;
  }>({ key: '', remote: EMPTY_REMOTE, loading: false, loadingMore: false, remoteAttempted: false });

  // Track current query context for pagination
  const generationRef = useRef(0);
  const contextRef = useRef({
    key: '',
    query: '',
    approvedOnly: false,
    intent: 'basic' as 'basic'|'packaged',
    controller: null as AbortController | null,
  });

  useEffect(() => {
    const trimmed = query.trim();
    const key = `${accountKey}\0${trimmed}\0${approvedOnly}\0${intent}`;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    contextRef.current.controller?.abort();
    contextRef.current = { key, query: trimmed, approvedOnly, intent, controller };
    setState({ key, remote: EMPTY_REMOTE, loading: trimmed.length >= 2, loadingMore: false, remoteAttempted: false });

    if (trimmed.length < 2) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await search(trimmed, {
            approvedOnly,
            includeBranded: includeBrandedFallback(approvedOnly),
            grouped: true,
            intent,
            limit: 6,
            signal: controller.signal,
          });
          if (controller.signal.aborted || generationRef.current !== generation || contextRef.current.key !== key) return;
          setState({ key, remote: result, loading: false, loadingMore: false, remoteAttempted: true });
        } catch (reason) {
          if (controller.signal.aborted || generationRef.current !== generation ||
              contextRef.current.key !== key || (reason instanceof Error && reason.name === 'AbortError')) return;
          setState({
            key,
            remote: EMPTY_REMOTE,
            loading: false,
            loadingMore: false,
            remoteAttempted: true,
            error: reason instanceof Error ? reason.message : 'Shared foods are unavailable.',
          });
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, approvedOnly, intent, accountKey, search]);

  const showMore = () => {
    const current = state.key === contextRef.current.key ? state : undefined;
    if (!current || current.loadingMore || current.loading || !current.remote.hasMore || !current.remote.nextCursor) return;

    const { query: ctxQuery, approvedOnly: ctxApproved, intent: ctxIntent } = contextRef.current;
    const key = contextRef.current.key;
    const generation = generationRef.current;
    const cursor = current.remote.nextCursor;
    const controller = new AbortController();
    contextRef.current.controller = controller;
    setState(previous => previous.key === key ? { ...previous, loadingMore: true, error: undefined } : previous);
    void (async () => {
      try {
        const result = await search(ctxQuery, {
          approvedOnly: ctxApproved,
          includeBranded: includeBrandedFallback(ctxApproved),
          grouped: true,
          intent: ctxIntent,
          cursor,
          limit: 6,
          signal: controller.signal,
        });
        if (controller.signal.aborted || generationRef.current !== generation || contextRef.current.key !== key) return;
        setState(previous => {
          if (previous.key !== key) return previous;
          return {
            ...previous,
            loadingMore: false,
            remote: {
              ...result,
              results: mergeCatalogResults(previous.remote.results ?? [], result.results ?? []),
              common: mergeCatalogResults(previous.remote.common, result.common),
              personal: mergeCatalogResults(previous.remote.personal, result.personal),
              branded: mergeCatalogResults(previous.remote.branded, result.branded),
            },
          };
        });
      } catch (reason) {
        if (controller.signal.aborted || generationRef.current !== generation || contextRef.current.key !== key ||
            (reason instanceof Error && reason.name === 'AbortError')) return;
        setState(previous => previous.key === key ? {
          ...previous,
          loadingMore: false,
          error: reason instanceof Error ? reason.message : 'Failed to load more results.',
        } : previous);
      }
    })();
  };

  const expectedKey = `${accountKey}\0${query.trim()}\0${approvedOnly}\0${intent}`;
  const currentState = state.key === expectedKey ? state : {
    key: expectedKey, remote: EMPTY_REMOTE, loading: query.trim().length >= 2,
    loadingMore: false, remoteAttempted: false, error: undefined,
  };
  const currentRemote = currentState.remote;
  const localResults = boundedLocalResults(local);
  const visibleResults =
    currentState.remoteAttempted && !currentState.error
      ? (currentRemote.results ?? [])
      : localResults;
  return {
    common: mergeCatalogResults(local.common, currentRemote.common),
    personal: mergeCatalogResults(local.personal, currentRemote.personal),
    branded: approvedOnly ? [] : currentRemote.branded,
    results: visibleResults,
    upstreamUnavailable: currentRemote.upstreamUnavailable,
    hasMore: currentRemote.hasMore,
    nextCursor: currentRemote.nextCursor,
    rankingVersion: currentRemote.rankingVersion,
    ...(currentRemote.message ? { message: currentRemote.message } : {}),
    loading: currentState.loading,
    loadingMore: currentState.loadingMore,
    remoteAttempted: currentState.remoteAttempted,
    showMore,
    ...(currentState.error ? { error: currentState.error } : {}),
  };
}