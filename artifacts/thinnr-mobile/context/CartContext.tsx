/**
 * The patient's shopping cart and the storefront it draws from.
 *
 * Lines persist per account (the guided demo keeps its own cart, each real
 * patient theirs) so a cart survives an app restart, and never leaks between
 * sign-ins on a shared device. The storefront (GET /patient-data/billing/shop)
 * is fetched once here and shared by the shop grid, product page, cart, and
 * checkout, so all four agree on prices, cadences, and availability. Demo
 * accounts get the bundled demo storefront synchronously; real accounts get
 * either the live storefront or an explicit error, never demo data.
 *
 * The pay attempt in flight (cart id + exact request + authorized quote)
 * persists next to the lines, written and confirmed BEFORE the request
 * leaves (Pay fails closed if the device cannot store it): after an
 * ambiguous checkout result the next Pay must replay that same attempt, even
 * across a remount or a reload, so the server can settle it instead of a
 * fresh cart id charging the card a second time. While an attempt is pending
 * the cart is locked: no line can be added, changed, or removed, so the
 * replay always describes exactly what the patient sees.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { usePatientAccount } from '@/context/PatientAccountContext';
import {
  addCartLine,
  cartItemCount,
  linesAfterPaidItems,
  pruneCartLines,
  removeCartLine,
  setCartLineCadence,
  setCartLineQuantity,
  type AddCartResult,
  type CartLine,
} from '@/lib/cart-math';
import type { PendingAttempt } from '@/lib/checkout-flow';
import { getShop } from '@/lib/patient-billing-api';
import type { CartCheckoutItem, PatientShop } from '@/lib/patient-billing-types';
import { buildDemoShop } from '@/lib/shop-catalog';

const STORAGE_PREFIX = 'thinnr_cart_v1:';

export type ShopStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The account a cart belongs to, captured by a pay flow when it starts. Every
 * step that outlives an await (card tokenizing, the 15-90 s checkout request)
 * re-checks it, and the store only accepts a commit or settlement for the
 * scope that is still active, so a sign-out or account switch mid-flight can
 * never store one patient's attempt with another's lines or prune the newly
 * active patient's cart when the old answer lands.
 */
export interface CartScope {
  /** Storage key of the cart the attempt was started from (one per account). */
  readonly key: string;
  /** The patient the cart belongs to; 'demo' for the persona. */
  readonly patientId: string;
}

export class CartScopeChangedError extends Error {
  constructor() {
    super('Your account changed before the payment was sent. Nothing was charged.');
    this.name = 'CartScopeChangedError';
  }
}

export interface CartContextValue {
  /** True once the persisted cart for the current account has been read. */
  hydrated: boolean;
  demo: boolean;
  lines: CartLine[];
  /** Sum of quantities, for the launcher badge. */
  count: number;
  /** True while a pay attempt is unsettled: every edit is refused until it is confirmed. */
  locked: boolean;
  add: (line: CartLine) => AddCartResult;
  setQuantity: (key: string, quantity: number) => void;
  setCadence: (key: string, cadenceWeeks: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** The checkout attempt whose result is still unknown; null when the next Pay may start fresh. */
  pending: PendingAttempt | null;
  /** The active account's cart scope (null until an account is known); a pay flow captures it before its first await. */
  scope: CartScope | null;
  /** True while the captured scope is still the active, hydrated cart. */
  isCurrentScope: (scope: CartScope) => boolean;
  /**
   * Stores the attempt on the device and resolves only once it is written;
   * rejects (and stores nothing) when it cannot be, or with
   * CartScopeChangedError when the scope is no longer the active cart.
   */
  commitPending: (attempt: PendingAttempt, scope: CartScope) => Promise<void>;
  /**
   * Takes back a committed attempt that was NEVER sent (the identity check
   * before the request failed): the scope's stored cart drops the attempt and
   * keeps its lines. Only the attempt with this cart id is removed.
   */
  abandonPending: (cartId: string, scope: CartScope) => Promise<void>;
  /**
   * The attempt reached a definite answer: drops every line a paid item names
   * and releases the attempt in ONE device write, so the store never holds paid
   * lines without the key that replays them. Resolves once the write settled
   * (or was refused; the attempt then stays on disk and replays as already paid).
   * Works on the scope's OWN stored cart; in-memory state moves only when that
   * scope is still active.
   */
  settlePending: (paid: ReadonlyArray<Pick<CartCheckoutItem, 'kind' | 'product_ids'>>, scope: CartScope) => Promise<void>;
  shop: PatientShop | null;
  shopStatus: ShopStatus;
  shopError: string | null;
  /** Loads the storefront (no-op while a load is in flight unless forced). */
  loadShop: (force?: boolean) => Promise<PatientShop | null>;
}

const CartContext = createContext<CartContextValue | null>(null);

interface StoredCart {
  lines: CartLine[];
  pending: PendingAttempt | null;
}

const EMPTY_STORED: StoredCart = { lines: [], pending: null };

async function readCart(key: string): Promise<StoredCart> {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(key) ?? null : await AsyncStorage.getItem(key);
    if (!raw) return EMPTY_STORED;
    const parsed = JSON.parse(raw) as { lines?: unknown; pending?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.lines)) return EMPTY_STORED;
    return { lines: parsed.lines.filter(isCartLine), pending: isPendingAttempt(parsed.pending) ? parsed.pending : null };
  } catch {
    return EMPTY_STORED;
  }
}

/** Writes the cart; rejects when the device could not store it. */
async function writeCartStrict(key: string, stored: StoredCart): Promise<void> {
  const serialized = JSON.stringify(stored);
  const keep = stored.lines.length > 0 || stored.pending !== null;
  if (Platform.OS === 'web') {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error('This browser cannot store the cart.');
    if (keep) storage.setItem(key, serialized);
    else storage.removeItem(key);
    return;
  }
  if (keep) await AsyncStorage.setItem(key, serialized);
  else await AsyncStorage.removeItem(key);
}

async function writeCart(key: string, stored: StoredCart): Promise<void> {
  try {
    await writeCartStrict(key, stored);
  } catch {
    // Best effort for line edits: losing the persisted copy only costs the
    // next cold start. A pay attempt never relies on this path (see commitPending).
  }
}

/** Proves the attempt is really on the device: written, then read back byte-for-byte. */
async function readRaw(key: string): Promise<string | null> {
  return Platform.OS === 'web' ? globalThis.localStorage?.getItem(key) ?? null : AsyncStorage.getItem(key);
}

function isPendingAttempt(value: unknown): value is PendingAttempt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const request = row.request as Record<string, unknown> | null | undefined;
  const quote = row.quote as Record<string, unknown> | null | undefined;
  return (
    typeof row.cartId === 'string' && !!row.cartId &&
    !!request && typeof request === 'object' &&
    Array.isArray(request.lines) &&
    typeof request.payment_method_id === 'string' &&
    !!request.shipping_address && typeof request.shipping_address === 'object' &&
    !!quote && typeof quote === 'object' && Array.isArray(quote.lines) && typeof quote.total_cents === 'number'
  );
}

function isCartLine(value: unknown): value is CartLine {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.product_id === 'string' &&
    typeof row.quantity === 'number' &&
    (row.purchase === 'one_time' || row.purchase === 'subscription') &&
    (row.cadence_weeks === null || typeof row.cadence_weeks === 'number')
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : 'Couldn’t load the shop. Please try again.';
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { account } = usePatientAccount();
  const scope = account.kind === 'real' ? account.patientId : account.kind === 'demo' ? 'demo' : null;
  const storageKey = scope ? `${STORAGE_PREFIX}${scope}` : null;
  const demo = account.kind === 'demo';

  const [lines, setLines] = useState<CartLine[]>([]);
  const [pending, setPendingState] = useState<PendingAttempt | null>(null);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const hydrated = storageKey !== null && hydratedKey === storageKey;
  // Live view of the active scope for continuations that outlive a render.
  const activeRef = useRef<{ key: string | null; hydrated: boolean }>({ key: storageKey, hydrated });
  activeRef.current = { key: storageKey, hydrated };
  const scopeValue = useMemo<CartScope | null>(() => (storageKey && scope ? { key: storageKey, patientId: scope } : null), [storageKey, scope]);
  const isCurrentScope = useCallback((candidate: CartScope) => activeRef.current.key === candidate.key && activeRef.current.hydrated, []);
  const [shop, setShop] = useState<PatientShop | null>(null);
  const [shopStatus, setShopStatus] = useState<ShopStatus>('idle');
  const [shopError, setShopError] = useState<string | null>(null);
  const shopFor = useRef<string | null>(null);
  const inFlight = useRef<Promise<PatientShop | null> | null>(null);
  const loadToken = useRef<symbol | null>(null);
  // Mirror of `pending` for the synchronous edit guards below.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Hydrate the persisted cart whenever the account scope changes.
  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setPendingState(null);
    setHydratedKey(null);
    if (!storageKey) return;
    void readCart(storageKey).then(stored => {
      if (cancelled) return;
      setLines(stored.lines);
      setPendingState(stored.pending);
      setHydratedKey(storageKey);
    });
    return () => { cancelled = true; };
  }, [storageKey]);

  // Persist after hydration; the effect runs on every change of lines or the pending attempt.
  useEffect(() => {
    if (!hydrated || !storageKey) return;
    void writeCart(storageKey, { lines, pending });
  }, [hydrated, storageKey, lines, pending]);

  // A storefront belongs to one account; drop it when the account changes.
  useEffect(() => {
    if (shopFor.current !== scope) {
      shopFor.current = scope;
      setShop(null);
      setShopStatus('idle');
      setShopError(null);
      inFlight.current = null;
    }
  }, [scope]);

  const loadShop = useCallback(async (force = false): Promise<PatientShop | null> => {
    if (account.kind === 'unresolved') {
      setShop(null);
      setShopStatus('error');
      setShopError('Your account could not be reached. Retry when you are online.');
      return null;
    }
    if (account.kind === 'demo') {
      const built = buildDemoShop();
      setShop(built);
      setShopStatus('ready');
      setShopError(null);
      return built;
    }
    if (inFlight.current && !force) return inFlight.current;
    const requestScope = scope;
    setShopStatus('loading');
    setShopError(null);
    const token = Symbol('shop-load');
    loadToken.current = token;
    const request: Promise<PatientShop | null> = (async () => {
      try {
        const result = await getShop();
        if (shopFor.current !== requestScope) return null;
        setShop(result);
        setShopStatus('ready');
        // Drop lines the office no longer sells that way (never under a
        // pending attempt: those lines are frozen until it settles).
        if (pendingRef.current) return result;
        setLines(current => {
          const pruned = pruneCartLines(current, result.products);
          return pruned.removed.length || pruned.lines.some((line, i) => line !== current[i]) ? pruned.lines : current;
        });
        return result;
      } catch (caught) {
        if (shopFor.current !== requestScope) return null;
        setShopStatus('error');
        setShopError(errorMessage(caught));
        return null;
      } finally {
        if (loadToken.current === token) inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [account.kind, scope]);

  // Mirror of `lines` so add() can answer synchronously (merged? full?)
  // without relying on when React runs a state updater.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const locked = pending !== null && !demo;
  const add = useCallback((line: CartLine): AddCartResult => {
    if (pendingRef.current) return { ok: false, lines: linesRef.current, reason: 'locked' };
    const result = addCartLine(linesRef.current, line);
    linesRef.current = result.lines;
    setLines(result.lines);
    return result;
  }, []);

  // Every edit is refused while an attempt is pending: the replay must
  // describe exactly the lines the patient is looking at.
  const setQuantity = useCallback((key: string, quantity: number) => {
    if (pendingRef.current) return;
    setLines(current => setCartLineQuantity(current, key, quantity));
  }, []);
  const setCadence = useCallback((key: string, cadenceWeeks: number) => {
    if (pendingRef.current) return;
    setLines(current => setCartLineCadence(current, key, cadenceWeeks));
  }, []);
  const remove = useCallback((key: string) => {
    if (pendingRef.current) return;
    setLines(current => removeCartLine(current, key));
  }, []);
  const clear = useCallback(() => { if (!pendingRef.current) setLines([]); }, []);
  const commitPending = useCallback(async (attempt: PendingAttempt, attemptScope: CartScope) => {
    if (!isCurrentScope(attemptScope)) throw new CartScopeChangedError();
    // The lines in memory are this scope's (checked above, and every mutator
    // is refused once the attempt is stored), so the snapshot is the attempt's own.
    const stored: StoredCart = { lines: linesRef.current, pending: attempt };
    const serialized = JSON.stringify(stored);
    try {
      await writeCartStrict(attemptScope.key, stored);
      if ((await readRaw(attemptScope.key)) !== serialized) throw new Error('read-back mismatch');
    } catch {
      throw new Error('This device couldn’t save your payment attempt, so nothing was charged. Free up storage or try again.');
    }
    if (!isCurrentScope(attemptScope)) {
      // The account moved on while the write was in flight: the attempt was
      // never sent, so take it back off that account's cart (best effort; a
      // leftover only re-shows as an unsent attempt for its own account).
      await writeCart(attemptScope.key, { lines: stored.lines, pending: null });
      throw new CartScopeChangedError();
    }
    pendingRef.current = attempt;
    setPendingState(attempt);
  }, [isCurrentScope]);
  const abandonPending = useCallback(async (cartId: string, attemptScope: CartScope) => {
    const stored = await readCart(attemptScope.key);
    if (stored.pending?.cartId !== cartId) return;
    await writeCart(attemptScope.key, { lines: stored.lines, pending: null });
    if (!isCurrentScope(attemptScope) || pendingRef.current?.cartId !== cartId) return;
    pendingRef.current = null;
    setPendingState(null);
  }, [isCurrentScope]);
  const settlePending = useCallback(async (paid: ReadonlyArray<Pick<CartCheckoutItem, 'kind' | 'product_ids'>>, attemptScope: CartScope) => {
    // The settlement works on the attempt's OWN stored cart: in memory while
    // its scope is still active (identical to disk while locked), otherwise
    // read back from its key so another account's lines are never touched.
    const current = isCurrentScope(attemptScope);
    const base = current ? linesRef.current : (await readCart(attemptScope.key)).lines;
    const pruned = linesAfterPaidItems(base, paid);
    // One write carries both halves of the settlement (pruned lines AND no
    // attempt), and it happens here rather than only from the persist effect:
    // a commit and a settle in the same render batch leave `pending` state
    // unchanged, so the effect would never run and the committed attempt would
    // outlive its answer. Written before state moves on, so a kill at any
    // point leaves the device either with the attempt (replays as already
    // paid) or without the paid lines; never paid lines without their key.
    const stored: StoredCart = { lines: pruned, pending: null };
    const expected = stored.lines.length > 0 ? JSON.stringify(stored) : null;
    try {
      await writeCartStrict(attemptScope.key, stored);
      if ((await readRaw(attemptScope.key)) !== expected) throw new Error('read-back mismatch');
    } catch {
      // The attempt stays on disk: a cold start replays it and the server
      // answers with the same result instead of charging again. The persist
      // effect below keeps retrying from the pruned in-memory state.
    }
    // Only the scope that is STILL active moves the shared state; a settlement
    // landing after a switch has already updated its own account's store above.
    if (!isCurrentScope(attemptScope)) return;
    linesRef.current = pruned;
    pendingRef.current = null;
    setLines(pruned);
    setPendingState(null);
  }, [isCurrentScope]);

  const value = useMemo<CartContextValue>(() => ({
    hydrated,
    demo,
    lines,
    count: cartItemCount(lines),
    locked,
    add,
    setQuantity,
    setCadence,
    remove,
    clear,
    pending,
    scope: scopeValue,
    isCurrentScope,
    commitPending,
    abandonPending,
    settlePending,
    shop,
    shopStatus,
    shopError,
    loadShop,
  }), [hydrated, demo, lines, locked, add, setQuantity, setCadence, remove, clear, pending, scopeValue, isCurrentScope, commitPending, abandonPending, settlePending, shop, shopStatus, shopError, loadShop]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart must be used within CartProvider');
  return value;
}

/** Launcher badge: 0 outside a provider so the menu can render anywhere. */
export function useCartCount(): number {
  return useContext(CartContext)?.count ?? 0;
}
