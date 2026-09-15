import { format, isToday, isYesterday } from 'date-fns';
import { type ConversationEvent } from '@workspace/api-client-react';

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
  return <p className="mt-3 text-xs italic text-muted-foreground">No internal notes yet.</p>;
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
                : 'rounded-lg rounded-bl-sm border border-card-border bg-card px-3.5 py-2.5 shadow-soft'
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
