/**
 * Subscribes a staff inbox screen to its live event stream.
 *
 * The stream (re)connects whenever `streamKey` changes (scope or open
 * thread) and closes on unmount. Handlers are read through refs so the
 * connection never churns on re-render, and the `after` cursor is read at
 * connect time so a reconnect resumes from what the screen already holds.
 * List hints are coalesced so a burst of changes triggers one list refetch.
 */
import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { openInboxStream, type InboxListHint, type InboxStreamFrame } from '@/lib/inbox-stream';

async function staffAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export interface UseInboxStreamOptions {
  enabled: boolean;
  /** Change this to reconnect (scope + open thread). */
  streamKey: string;
  /** Root-relative stream path (office: /api/office/conversations/stream). */
  path: string;
  /** Extra query parameters, read at connect time. */
  params: () => Record<string, string | number | undefined>;
  /** Called on every ready; `afterDrop` marks a catch-up point. Also called
   * on the very first ready because anything written between the screen's
   * initial fetch and the subscription would otherwise slip through. */
  onReady: (info: { afterDrop: boolean; cursor: number }) => void;
  onList: (hints: InboxListHint[]) => void;
  onEvents: (frame: Extract<InboxStreamFrame, { type: 'events' }>) => void;
  /** Coalescing window for list hints (ms). */
  listDebounceMs?: number;
}

export function useInboxStream(options: UseInboxStreamOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled, streamKey, path } = options;

  useEffect(() => {
    if (!enabled) return;
    let pendingHints: InboxListHint[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushHints = () => {
      flushTimer = null;
      const hints = pendingHints;
      pendingHints = [];
      if (hints.length > 0) optionsRef.current.onList(hints);
    };
    const handle = openInboxStream({
      url: () => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(optionsRef.current.params())) {
          if (value !== undefined && value !== '') search.set(key, String(value));
        }
        const query = search.toString();
        return query ? `${path}?${query}` : path;
      },
      getToken: staffAccessToken,
      handlers: {
        onReady: (frame, info) => optionsRef.current.onReady({ afterDrop: info.afterDrop, cursor: frame.cursor }),
        onList: hints => {
          pendingHints.push(...hints);
          if (!flushTimer) flushTimer = setTimeout(flushHints, optionsRef.current.listDebounceMs ?? 250);
        },
        onEvents: frame => optionsRef.current.onEvents(frame),
      },
    });
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      handle.close();
    };
  }, [enabled, streamKey, path]);
}
