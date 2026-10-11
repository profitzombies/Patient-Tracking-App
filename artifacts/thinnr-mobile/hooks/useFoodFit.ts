/**
 * "Fits your diet" for any food the app shows. One memoised classifier per
 * screen, built from the diet slice: the protocol phase answers from the
 * Approved Foods list, every other phase from the chosen diet plus the
 * patient's lists. Without a loaded diet slice the verdict is "unknown" and
 * nothing is badged — a badge must never come from guessed state.
 */
import { useCallback, useMemo } from 'react';
import { usePatient } from '@/context/PatientContext';
import { classifyCatalogFood, type ClassifierContext, type FitResult, type FitVerdict } from '@/lib/diet-fit';
import { fitContextFor, type DietState } from '@/lib/diet-state';
import { describeFood, type DescribableFood } from '@/lib/food-description';

export interface FoodFit {
  /** Null until the diet slice has loaded (demo loads synchronously). */
  context: ClassifierContext | null;
  /** True while the Approved Foods list is the fit source (protocol phase). */
  protocol: boolean;
  classify: (food: DescribableFood) => FitResult;
  verdict: (food: DescribableFood) => FitVerdict;
  /** Short label for the active fit source, used by filter chips and section headers. */
  sourceLabel: string;
}

const UNKNOWN: FitResult = { verdict: 'unknown', reasons: [] };

/** Pure core shared by the hook and the suites. */
export function foodFitFor(diet: DietState | null): FoodFit {
  const context = fitContextFor(diet);
  const protocol = context?.phase === 'protocol';
  const classify = (food: DescribableFood): FitResult => {
    if (!context) return UNKNOWN;
    return classifyCatalogFood(describeFood(food), food.id ?? food.refId, context);
  };
  return {
    context,
    protocol,
    classify,
    verdict: food => classify(food).verdict,
    sourceLabel: protocol ? 'Approved Foods' : 'Fits your diet',
  };
}

export function useFoodFit(): FoodFit {
  const { diet, dietStatus } = usePatient();
  const ready = dietStatus === 'live' ? diet : null;
  const fit = useMemo(() => foodFitFor(ready), [ready]);
  const classify = useCallback((food: DescribableFood) => fit.classify(food), [fit]);
  const verdict = useCallback((food: DescribableFood) => fit.verdict(food), [fit]);
  return useMemo(() => ({ ...fit, classify, verdict }), [fit, classify, verdict]);
}
