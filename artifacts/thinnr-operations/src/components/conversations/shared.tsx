import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { StickyNote, X } from 'lucide-react';
import { type ConversationEvent, type ProductSuggestion, type ProductSuggestionItem } from '@workspace/api-client-react';

const formatSuggestionPrice = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const suggestionPurchaseLabel = (item: ProductSuggestionItem) =>
  item.purchase === 'subscription' ? `Every ${item.cadenceWeeks} weeks` : 'One-time';

function SuggestionThumbnail({ item }: { item: ProductSuggestionItem }) {
  return item.imageUrl ? (
    <img src={item.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded-md border border-border object-cover" />
  ) : (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border bg-accent text-sm font-bold text-primary">
      {item.name.charAt(0)}
    </span>
  );
}

function ProductSuggestionCards({ suggestion }: { suggestion: ProductSuggestion }) {
  if (suggestion.mode === 'bundle') {
    return (
      <div className="mt-2.5 rounded-lg border border-primary/25 bg-card p-3 shadow-soft" data-testid="product-suggestion-bundle">
        <p className="text-[10px] font-bold uppercase tracking-[.12em] text-primary">Bundle</p>
        <div className="mt-2 divide-y divide-border">
          {suggestion.items.map(item => (
            <div key={`${item.productId}-${item.purchase}-${item.cadenceWeeks}`} className="flex items-start justify-between gap-3 py-2 first:pt-0">
              <div className="min-w-0">
                <p className="font-serif text-xs font-bold text-navy">{item.name}</p>
                <p className="text-[10px] text-muted-foreground">{suggestionPurchaseLabel(item)} · ×{item.quantity}</p>
              </div>
              <p className="shrink-0 text-xs font-semibold text-navy">{formatSuggestionPrice(item.unitPriceCents * item.quantity)}</p>
            </div>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-primary/15 pt-2">
          <span className="font-serif text-sm font-bold text-navy">Total</span>
          <span className="text-sm font-bold text-navy">{formatSuggestionPrice(suggestion.totalCents)}</span>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">Opens checkout in the patient app</p>
      </div>
    );
  }

  return (
    <div className="mt-2.5 space-y-2" data-testid="product-suggestion-individual">
      {suggestion.items.map(item => (
        <div key={`${item.productId}-${item.purchase}-${item.cadenceWeeks}`} className="rounded-lg border border-primary/20 bg-card p-2.5 shadow-soft">
          <div className="flex items-center gap-2.5">
            <SuggestionThumbnail item={item} />
            <div className="min-w-0 flex-1">
              <p className="font-serif text-xs font-bold text-navy">{item.name}</p>
              <p className="text-[10px] text-muted-foreground">{suggestionPurchaseLabel(item)} · ×{item.quantity}</p>
            </div>
            <p className="shrink-0 text-xs font-semibold text-navy">{formatSuggestionPrice(item.unitPriceCents)}</p>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">Sent as a suggestion</p>
        </div>
      ))}
    </div>
  );
}

export function InitialsAvatar({ name }: { name: string | undefined }) {
  const initials = (name || '')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-[11px] font-bold text-primary"
    >
      {initials || '?'}
    </span>
  );
}

/**
 * Distance (px) from the pane's scrolled position to its bottom edge, or
 * `Infinity` when the pane cannot be measured.
 */
export function distanceFromThreadBottom(pane: HTMLElement | null): number {
  if (!pane) return Infinity;
  return pane.scrollHeight - pane.clientHeight - pane.scrollTop;
}

/**
 * Scroll the thread pane so the newest-message anchor sits at its bottom
 * edge. Scrolls only the pane itself (never the window or the outer shell)
 * so the notes card and the header stay put. No-op when the anchor is
 * already in view or the nodes are not real DOM elements.
 */
export function scrollThreadToNewest(pane: HTMLElement | null, anchor: HTMLElement | null) {
  if (!pane || !anchor || typeof pane.getBoundingClientRect !== 'function' || typeof anchor.getBoundingClientRect !== 'function') return;
  const paneRect = pane.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const delta = anchorRect.bottom - paneRect.bottom;
  if (delta <= 0) return;
  pane.scrollTop += delta;
}

/**
 * What the newest-message auto-scroll remembered from its last run: which
 * thread it followed, in which pane element, and how tall the transcript was.
 */
export interface ThreadFollowState {
  threadKey: string;
  pane: HTMLElement | null;
  scrollHeight: number;
}

/**
 * Decide whether an auto-scroll to the newest message should run, and return
 * the state to remember for the next decision.
 *
 * - The first transcript for a thread always scrolls. "First" is keyed to
 *   the thread AND the pane element: closing a thread unmounts the pane, so
 *   reopening the same thread mounts a fresh pane at scrollTop 0 and must
 *   scroll again.
 * - Afterwards (a poll or a sent reply grew the list) it only scrolls if the
 *   reader was at the newest end BEFORE the growth landed. This runs after
 *   commit, so the new content is already in the pane; subtracting the
 *   height growth since the last run recovers the pre-growth distance, and
 *   a tall incoming message cannot make an at-the-bottom reader look far
 *   away. Paging older messages in at the top never reaches this decision
 *   (the newest seq does not change), and a reader who scrolled up to read
 *   stays put.
 */
export function planThreadFollow(
  previous: ThreadFollowState | null,
  threadKey: string,
  pane: HTMLElement | null,
  nearBottomPx = 120,
): { follow: boolean; next: ThreadFollowState } {
  const next: ThreadFollowState = { threadKey, pane, scrollHeight: pane?.scrollHeight ?? 0 };
  const firstForThread = !previous || previous.threadKey !== threadKey || previous.pane !== pane;
  if (firstForThread) return { follow: true, next };
  const growth = Math.max(0, next.scrollHeight - previous.scrollHeight);
  const distanceBeforeGrowth = distanceFromThreadBottom(pane) - growth;
  return { follow: distanceBeforeGrowth <= nearBottomPx, next };
}

export function ThreadNotesEmpty() {
  return <p className="text-xs italic text-muted-foreground">No internal notes yet.</p>;
}

export function SealedConversationNotice() {
  return (
    <p className="text-xs font-medium text-muted-foreground" role="status" data-testid="text-sealed-conversation">
      This account is closed; the record is read-only.
    </p>
  );
}

/** Breakpoint at which the notes panel docks beside the thread instead of overlaying it. */
const NOTES_DOCK_QUERY = '(min-width: 1024px)';

/**
 * Open/closed state for the internal-notes side panel. Docked (wide) layouts
 * start open; narrow layouts start closed so the overlay never hides the
 * thread until staff ask for it. Environments without matchMedia (tests,
 * SSR) keep the panel open. Closing returns focus to the toggle so keyboard
 * users are not dropped behind the (now removed) overlay.
 */
export function useThreadNotesPanel() {
  const [open, setOpen] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia(NOTES_DOCK_QUERY).matches) setOpen(false);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);
  return { open, setOpen, close, toggle: () => setOpen(current => !current), toggleRef };
}

/** True when the panel currently overlays the thread rather than docking beside it. */
function isNotesOverlay() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia(NOTES_DOCK_QUERY).matches;
}

const NOTES_PANEL_ID = 'thread-notes-panel';

export interface ThreadNote { id: string; body: string; authorLabel: string; createdAt: string }

export const ThreadNotesToggle = forwardRef<HTMLButtonElement, { open: boolean; count: number | undefined; onClick: () => void }>(
  function ThreadNotesToggle({ open, count, onClick }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        aria-controls={NOTES_PANEL_ID}
        aria-label={open ? 'Hide internal notes' : 'Show internal notes'}
        data-testid="button-toggle-notes"
        onClick={onClick}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          open ? 'border-primary/30 bg-accent text-primary' : 'border-border bg-card text-navy hover:bg-paper-alt'
        }`}
      >
        <StickyNote size={13} aria-hidden="true" />
        Notes
        {typeof count === 'number' && count > 0 && (
          <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${open ? 'bg-primary/15' : 'bg-muted'}`}>{count}</span>
        )}
      </button>
    );
  },
);

/**
 * Internal-notes side panel: a full-height white column with its own header,
 * scrolling note list and an optional pinned composer. Docks beside the
 * thread on wide layouts and overlays the thread (with a shadow edge) on
 * narrow ones. The parent body row must be `relative`.
 */
export function ThreadNotesPanel({
  open, onClose, caption, notes, isError, composer,
}: {
  open: boolean;
  onClose: () => void;
  caption: string;
  notes: ThreadNote[] | undefined;
  isError: boolean;
  composer?: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // When the panel covers the thread, move focus into it so keyboard users
  // land on the panel instead of tabbing through the obscured composer.
  useEffect(() => {
    if (open && isNotesOverlay()) closeRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <aside
      id={NOTES_PANEL_ID}
      aria-label="Internal notes"
      data-testid="thread-notes-panel"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
      className="absolute inset-y-0 right-0 z-10 flex w-full max-w-[320px] flex-col border-l border-border bg-card shadow-[-12px_0_28px_-16px_rgba(20,33,61,0.35)] lg:static lg:w-[300px] lg:shrink-0 lg:shadow-none"
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 font-serif text-sm font-bold text-navy">
            <StickyNote size={13} className="text-primary" aria-hidden="true" />
            Internal notes
          </h3>
          <p className="mt-0.5 text-[10px] font-semibold text-warn">{caption}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="Hide internal notes"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-paper-alt hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isError ? <p role="alert" className="text-xs text-destructive">Notes could not be loaded.</p>
          : !notes ? <p className="text-xs text-muted-foreground">Loading notes…</p>
          : notes.length === 0 ? <ThreadNotesEmpty />
          : (
            <ul className="space-y-2">
              {notes.map(note => (
                <li key={note.id} className="rounded-md border border-card-border bg-paper-alt px-2.5 py-2 text-xs">
                  <p className="whitespace-pre-wrap leading-relaxed">{note.body}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{note.authorLabel} · {formatRelativeTime(note.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
      </div>
      {composer && <div className="shrink-0 border-t border-border px-4 py-3">{composer}</div>}
    </aside>
  );
}

export function formatRelativeTime(dateString: string) {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return '';
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'MMM d, yyyy');
}

export function LiveMessageRow({ message }: { message: ConversationEvent }) {
  const isUser = message.role === 'user';
  const isStaff = message.role === 'staff';
  const timeLabel = format(new Date(message.createdAt), 'h:mm a');

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] md:max-w-[72%] ${isUser ? 'items-end' : 'items-start'}`}>
        {isStaff && <p className="mb-1 text-[10px] font-bold uppercase tracking-[.1em] text-primary">{message.senderLabel ?? 'Care team'}</p>}
        <div
          className={
            isUser
              ? 'rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 text-primary-foreground shadow-xs'
              : isStaff
                ? 'rounded-lg rounded-bl-sm border border-primary/25 bg-accent px-3.5 py-2.5 shadow-soft'
                : 'rounded-lg rounded-bl-sm border border-card-border bg-paper-alt px-3.5 py-2.5 shadow-soft'
          }
        >
          {message.text.split('\n\n').map((block, index) => (
            <p
              key={index}
              className={`text-xs leading-relaxed ${index > 0 ? 'mt-2.5' : ''} ${isUser ? '' : 'text-foreground'}`}
            >
              {block}
            </p>
          ))}
          {message.stopped && (
            <p className="mt-2 text-[10px] italic text-destructive opacity-80">
              Message stopped by user
            </p>
          )}
        </div>
        {isStaff && message.suggestion ? <ProductSuggestionCards suggestion={message.suggestion} /> : null}
        <p className={`mt-1.5 text-[10px] text-muted-foreground ${isUser ? 'text-right' : ''}`}>{timeLabel}</p>
      </div>
    </div>
  );
}

/**
 * Re-baseline the remembered transcript height without taking a follow
 * decision. Older history paged in at the top grows the pane while the
 * browser's scroll anchoring keeps the reader in place; if that growth were
 * left in the baseline, the next appended message would count the whole
 * older batch as "new" and could yank a reader who is browsing history.
 */
export function refreshThreadFollowBaseline(state: ThreadFollowState | null, pane: HTMLElement | null): ThreadFollowState | null {
  if (!state || state.pane !== pane) return state;
  return { ...state, scrollHeight: pane?.scrollHeight ?? 0 };
}
