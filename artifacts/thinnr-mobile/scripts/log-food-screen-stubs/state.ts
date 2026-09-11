import React from 'react';

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type LoggableItem = {
  refId: string;
  kind: 'food' | 'recipe';
  name: string;
  sub: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  approved?: boolean;
  catalog?: Record<string, unknown>;
};

export const DIARY_MIN_KEY = '2020-01-01';
export const MEAL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const MEAL_LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

export function formatDateKey(value: string): string {
  return value;
}

export function shiftDateKey(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function yesterdaySlotPreview(): null {
  return null;
}

export const colors = {
  accent: '#eef4ff',
  activeGreen: '#16794b',
  background: '#f7f9fc',
  bodyText: '#354052',
  border: '#d7deea',
  card: '#ffffff',
  cobalt: '#2364d2',
  foreground: '#10223b',
  labelText: '#61708a',
  navy: '#10223b',
  navyLight: '#234261',
  paperCardAlt: '#ffffff',
  primaryForeground: '#ffffff',
  radiusSm: 6,
  riskText: '#a63c3c',
  sidebarBg: '#f0f5ff',
  subtleText: '#77849a',
};

export function useColors() {
  return colors;
}

export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

export function useAppMode() {
  return { mode: 'patient' as const, hydrated: true };
}

type CatalogState = {
  common: any[];
  personal: any[];
  branded: any[];
  results: any[];
  loading: boolean;
  error?: string;
  message?: string;
  upstreamUnavailable: boolean;
  remoteAttempted: boolean;
  querySuggestions: string[];
  correctedQuery?: string;
  hasMore: boolean;
  nextCursor?: string;
  loadingMore: boolean;
  pagingError?: string;
  retry: () => void;
  showMore: () => void;
};

export const catalogState: CatalogState = {
  common: [],
  personal: [],
  branded: [],
  results: [],
  loading: false,
  upstreamUnavailable: false,
  remoteAttempted: false,
  querySuggestions: [],
  hasMore: false,
  loadingMore: false,
  retry: () => {},
  showMore: () => {},
};

export const catalogCalls = {
  retry: 0,
  showMore: 0,
};

function retryCatalog(): void {
  catalogCalls.retry += 1;
}

function showMoreCatalog(): void {
  catalogCalls.showMore += 1;
}

export function resetCatalogState(): void {
  catalogState.common = [];
  catalogState.personal = [];
  catalogState.branded = [];
  catalogState.results = [];
  catalogState.loading = false;
  delete catalogState.error;
  delete catalogState.message;
  catalogState.upstreamUnavailable = false;
  catalogState.remoteAttempted = false;
  catalogState.querySuggestions = [];
  delete catalogState.correctedQuery;
  catalogState.hasMore = false;
  delete catalogState.nextCursor;
  catalogState.loadingMore = false;
  delete catalogState.pagingError;
  catalogCalls.retry = 0;
  catalogCalls.showMore = 0;
  catalogState.retry = retryCatalog;
  catalogState.showMore = showMoreCatalog;
}

export function setCatalogState(next: Partial<CatalogState>): void {
  Object.assign(catalogState, next);
}

export function useFoodCatalogSearch(): CatalogState {
  return catalogState;
}

export function catalogFoodToLoggable(food: any): any {
  return food.loggable ?? food;
}

const itemStore: { items: LoggableItem[] } = { items: [] };

export function setAllItems(items: LoggableItem[]): void {
  itemStore.items = items;
}

export function useLoggableItems() {
  return {
    allItems: itemStore.items,
    byId: new Map(itemStore.items.map(item => [item.refId, item])),
  };
}

export function selectionMatchesItemConfiguration(): boolean {
  return false;
}

export function foodResultDisplayText(item: LoggableItem): string {
  return item.serving;
}

export function getItemNutritionSnapshot(): undefined {
  return undefined;
}

export function selectionDisplayText(): string {
  return '';
}

export function buildFoodLogEntry(selection: any, details: any): any {
  return { ...details, ...selection };
}

export function withItemNutritionSnapshot(item: any): any {
  return item;
}

export function scaledSnapshotMacros(): undefined {
  return undefined;
}

export function snapshotConfigurationId(): string {
  return '';
}

export function catalogFoodSnapshot(food: any): any {
  return food;
}

export async function selectCatalogFood(food: any): Promise<any> {
  return food;
}

export async function runAccountGuardedSteps(
  first: () => Promise<any>,
  second: (value: any) => Promise<any>,
): Promise<{ status: 'ok'; second: any }> {
  const value = await first();
  return { status: 'ok', second: await second(value) };
}

export function toTitleCase(value: string): string {
  return value;
}

export type PatientState = {
  allFoods: any[];
  customFoods: any[];
  catalogFoods: any[];
  recents: string[];
  favorites: string[];
};

export const patientState: PatientState = {
  allFoods: [],
  customFoods: [],
  catalogFoods: [],
  recents: [],
  favorites: [],
};

export function resetPatientState(): void {
  patientState.allFoods = [];
  patientState.customFoods = [];
  patientState.catalogFoods = [];
  patientState.recents = [];
  patientState.favorites = [];
}

export function usePatient() {
  return {
    hydrated: true,
    ...patientState,
    todayKey: '2026-09-08',
    entriesForDate: () => [],
    async saveFoodConfiguration(food: any) {
      return food;
    },
    async addCustomFood(food: any) {
      return { id: 'custom-test', ...food };
    },
    async toggleFavorite() {},
    async submitFoodEntries() {
      return { outcome: 'saved' as const };
    },
  };
}

export function usePatientSync() {
  return {
    foodSubmissions: [],
    retryFoodSubmission: () => false,
  };
}

export function usePatientAccount() {
  return {
    resolving: false,
    account: { kind: 'demo' as const },
    accountNotice: null,
    retryResolve() {},
  };
}

export const basketState = {
  selected: [] as Array<{ basketId: string; item: LoggableItem; quantity: number }>,
};

export function useFoodLogging() {
  return {
    selected: basketState.selected,
    toggle() {},
    remove() {},
    clear() {},
    remember() {},
    configure() {},
  };
}

export function resetScreenState(): void {
  resetCatalogState();
  resetPatientState();
  setAllItems([]);
  basketState.selected = [];
}

export function Divider(props: { children?: React.ReactNode; style?: unknown }) {
  return React.createElement('Divider', props, props.children);
}

export function EmptyState(props: { title: string; body: string; icon?: React.ReactNode }) {
  return React.createElement(
    'EmptyState',
    props,
    React.createElement('Text', null, props.title),
    React.createElement('Text', null, props.body),
  );
}

export function LedgerCard(props: { children?: React.ReactNode; style?: unknown }) {
  return React.createElement('LedgerCard', props, props.children);
}

export function PillSelector(props: {
  options: Array<{ label: string; value: string }>;
  selected: string;
  onSelect: (value: string) => void;
  style?: unknown;
}) {
  return React.createElement(
    'PillSelector',
    props,
    props.options.map(option => React.createElement(
      'Pressable',
      { key: option.value, onPress: () => props.onSelect(option.value) },
      React.createElement('Text', null, option.label),
    )),
  );
}

export function OrdinaryTextInput(props: Record<string, unknown>) {
  return React.createElement('TextInput', props);
}

export function KeyboardAwareScrollViewCompat(props: { children?: React.ReactNode; [key: string]: unknown }) {
  return React.createElement('ScrollView', props, props.children);
}

export function ApprovedBadge(props: Record<string, unknown>) {
  return React.createElement('ApprovedBadge', props);
}

export const routerCalls: Array<{ method: string; target: unknown }> = [];

function routeTarget(target: unknown): unknown {
  return target && typeof target === 'object' && 'pathname' in target
    ? (target as { pathname: unknown }).pathname
    : target;
}

export const router = {
  push(target: unknown) {
    routerCalls.push({ method: 'push', target: routeTarget(target) });
  },
  replace(target: unknown) {
    routerCalls.push({ method: 'replace', target: routeTarget(target) });
  },
  back() {
    routerCalls.push({ method: 'back', target: '' });
  },
  canGoBack() {
    return false;
  },
};

export function Redirect(): null {
  return null;
}

export function useLocalSearchParams<T extends Record<string, unknown>>(): T {
  return {} as T;
}