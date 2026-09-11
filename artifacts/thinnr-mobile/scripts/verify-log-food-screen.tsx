import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import LogFoodScreen from '../app/log-food';
import {
  catalogCalls,
  resetScreenState,
  setAllItems,
  setCatalogState,
  catalogState,
  type LoggableItem,
} from './log-food-screen-stubs/state';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const food = (refId: string, name: string): LoggableItem => ({
  refId,
  kind: 'food',
  name,
  sub: 'Common Foods',
  serving: '1 cup',
  calories: 100,
  protein: 4,
  carbs: 20,
  fat: 1,
});

const recipe: LoggableItem = {
  refId: 'recipe-omelette',
  kind: 'recipe',
  name: 'Omelette',
  sub: 'Breakfast recipe',
  serving: '1 serving',
  calories: 240,
  protein: 18,
  carbs: 4,
  fat: 16,
};

function hosts(renderer: ReactTestRenderer, testID: string): ReactTestInstance[] {
  return renderer.root.findAll(node => (
    typeof node.type === 'string' && node.props.testID === testID
  ));
}

function host(renderer: ReactTestRenderer, testID: string): ReactTestInstance {
  const matches = hosts(renderer, testID);
  assert.equal(matches.length, 1, `expected one host with testID ${testID}, got ${matches.length}`);
  return matches[0];
}

function treeText(node: ReactTestInstance): string {
  return node.children.map(child => (
    typeof child === 'string' ? child : treeText(child)
  )).join('');
}

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll(node => (
    typeof node.type === 'string' && treeText(node).includes(text)
  )).length > 0;
}

function press(node: ReactTestInstance): void {
  assert.equal(typeof node.props.onPress, 'function', 'pressed host should expose onPress');
  act(() => {
    node.props.onPress();
  });
}

function changeText(renderer: ReactTestRenderer, value: string): void {
  const input = host(renderer, 'logfood-search');
  assert.equal(typeof input.props.onChangeText, 'function');
  act(() => {
    input.props.onChangeText(value);
  });
}

function pressText(renderer: ReactTestRenderer, text: string): void {
  const matches = renderer.root.findAll(node => (
    typeof node.type === 'string' &&
    node.type === 'Pressable' &&
    treeText(node) === text
  ));
  assert.equal(matches.length, 1, `expected one Pressable labeled ${text}, got ${matches.length}`);
  press(matches[0]);
}

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(LogFoodScreen));
  });
  return renderer;
}

function rerender(renderer: ReactTestRenderer): void {
  act(() => {
    renderer.update(React.createElement(LogFoodScreen));
  });
}

async function testInitialLoadingSkeleton(): Promise<void> {
  resetScreenState();
  const first = food('rice-1', 'White rice');
  const second = food('rice-2', 'Brown rice');
  setCatalogState({
    results: [first, second],
    loading: true,
    remoteAttempted: true,
  });

  const renderer = await renderScreen();
  changeText(renderer, 'rice');

  assert.equal(hosts(renderer, 'logfood-search-loading').length, 1);
  assert.equal(hosts(renderer, 'food-search-skeleton-row').length, 4,
    'initial loading fills the six-row budget without replacing local rows');
  assert.equal(hosts(renderer, 'logfood-item-rice-1').length, 1);
  assert.equal(hosts(renderer, 'logfood-item-rice-2').length, 1);
  assert.equal(hasText(renderer, 'Searching the shared catalog'), false,
    'pending search does not add a status sentence above the results');
  assert.equal(hasText(renderer, '2 ITEMS'), false,
    'pending search does not render a stale item count');
  assert.equal(hasText(renderer, 'No matches'), false,
    'pending search is not an empty settled state');
  assert.equal(hosts(renderer, 'logfood-more-ways-toggle').length, 0,
    'More ways is hidden while the initial search is pending');

  setCatalogState({ results: [], loading: true });
  rerender(renderer);
  assert.equal(hasText(renderer, '0 ITEMS'), false,
    'a pending empty result never flashes a zero count');
  assert.equal(hasText(renderer, 'No matches'), false);
  renderer.unmount();
}

async function testSearchLinksLiveInMoreWays(): Promise<void> {
  resetScreenState();
  setCatalogState({ results: [food('settled-rice', 'Settled rice')], remoteAttempted: true });
  const renderer = await renderScreen();
  changeText(renderer, 'rice');

  assert.equal(hasText(renderer, 'Basic foods'), false);
  assert.equal(hasText(renderer, 'Search packaged foods'), false);
  assert.equal(hasText(renderer, 'Search recipes'), false);
  press(host(renderer, 'logfood-more-ways-toggle'));
  assert.equal(hasText(renderer, 'Basic foods'), true);
  assert.equal(hasText(renderer, 'Search packaged foods'), true);
  assert.equal(hasText(renderer, 'Search recipes'), true);
  renderer.unmount();
}

async function testErrorsAndSettledEmptyState(): Promise<void> {
  resetScreenState();
  setCatalogState({
    error: 'Shared catalog is unavailable',
    remoteAttempted: true,
  });
  const renderer = await renderScreen();
  changeText(renderer, 'rice');

  assert.equal(hasText(renderer, 'Shared catalog is unavailable'), true);
  assert.equal(hosts(renderer, 'logfood-catalog-retry').length, 1);
  assert.equal(hasText(renderer, 'No matches'), false,
    'a genuine catalog error is not mislabeled as an empty result');
  press(host(renderer, 'logfood-catalog-retry'));
  assert.equal(catalogCalls.retry, 1);

  setCatalogState({ error: undefined, upstreamUnavailable: true });
  rerender(renderer);
  assert.equal(hasText(renderer, 'No matches'), false,
    'an upstream-unavailable result is not mislabeled as empty');

  setCatalogState({ upstreamUnavailable: false, remoteAttempted: true });
  rerender(renderer);
  assert.equal(hasText(renderer, 'No matches'), true,
    'No matches appears only after a settled successful empty search');
  renderer.unmount();
}

async function testLoadingMoreSkeletons(): Promise<void> {
  resetScreenState();
  const first = food('page-one', 'Page one');
  const second = food('page-two', 'Page two');
  setCatalogState({
    results: [first],
    hasMore: true,
    remoteAttempted: true,
  });
  const renderer = await renderScreen();
  changeText(renderer, 'page');
  assert.equal(hosts(renderer, 'logfood-item-page-one').length, 1);
  assert.equal(hosts(renderer, 'logfood-show-more').length, 1);

  setCatalogState({ loadingMore: true });
  rerender(renderer);
  assert.equal(hosts(renderer, 'logfood-search-loading-more').length, 1);
  assert.equal(hosts(renderer, 'food-search-skeleton-row').length, 3);
  assert.equal(hosts(renderer, 'logfood-show-more').length, 0,
    'the pagination control is hidden rather than showing Loading...');
  assert.equal(hasText(renderer, 'Loading...'), false);
  assert.equal(hosts(renderer, 'logfood-item-page-one').length, 1,
    'current result rows remain while the next page loads');

  setCatalogState({ results: [first, second], loadingMore: false, hasMore: false });
  rerender(renderer);
  assert.equal(hosts(renderer, 'logfood-search-loading-more').length, 0);
  assert.equal(hosts(renderer, 'logfood-item-page-one').length, 1);
  assert.equal(hosts(renderer, 'logfood-item-page-two').length, 1);
  renderer.unmount();
}

async function testRecipeIntentAndClearing(): Promise<void> {
  resetScreenState();
  setAllItems([recipe]);
  setCatalogState({
    results: [food('catalog-omelette', 'Catalog omelette')],
    remoteAttempted: true,
  });
  const renderer = await renderScreen();
  changeText(renderer, 'omelette');
  press(host(renderer, 'logfood-more-ways-toggle'));
  pressText(renderer, 'Search recipes');

  assert.equal(hosts(renderer, 'logfood-item-recipe-omelette').length, 1,
    'recipe intent immediately uses local recipes');
  assert.equal(hosts(renderer, 'logfood-group-recipes').length, 1);
  assert.equal(hosts(renderer, 'logfood-item-catalog-omelette').length, 0);

  setCatalogState({
    loading: true,
    error: 'catalog should be irrelevant to recipes',
    hasMore: true,
    loadingMore: true,
  });
  rerender(renderer);
  assert.equal(hosts(renderer, 'logfood-item-recipe-omelette').length, 1);
  assert.equal(hosts(renderer, 'logfood-catalog-state').length, 0,
    'recipe intent ignores catalog loading and errors');
  assert.equal(hosts(renderer, 'logfood-search-loading').length, 0);
  assert.equal(hosts(renderer, 'logfood-search-loading-more').length, 0);
  assert.equal(hosts(renderer, 'logfood-show-more').length, 0);

  press(host(renderer, 'logfood-more-ways-toggle'));
  changeText(renderer, '');
  assert.equal(hasText(renderer, 'Recent'), true);
  assert.equal(hasText(renderer, 'Favorites'), true);
  assert.equal(hosts(renderer, 'logfood-more-ways-toggle').length, 1);
  assert.equal(hasText(renderer, 'Search recipes'), false,
    'clearing the query collapses the mode links and resets their context');

  setCatalogState({
    loading: false,
    error: undefined,
    upstreamUnavailable: false,
    hasMore: false,
    results: [food('catalog-after-clear', 'Catalog omelette')],
  });
  changeText(renderer, 'omelette');
  assert.equal(hosts(renderer, 'logfood-group-results').length, 1,
    'clearing the query resets the next search to basic catalog intent');
  assert.equal(hosts(renderer, 'logfood-item-catalog-after-clear').length, 1);
  assert.equal(hosts(renderer, 'logfood-group-recipes').length, 0);
  renderer.unmount();
}

async function main(): Promise<void> {
  await testInitialLoadingSkeleton();
  await testSearchLinksLiveInMoreWays();
  await testErrorsAndSettledEmptyState();
  await testLoadingMoreSkeletons();
  await testRecipeIntentAndClearing();
  console.log('log-food loading UI regression checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});