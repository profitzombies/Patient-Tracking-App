/**
 * Provider-account lock state — the one piece of account data that lives in
 * Supabase instead of the seeded demo session.
 *
 * A row in provider_account_locks means THINNR shut off that office's access:
 * the office side blocks its staff, while HQ keeps full visibility. Rows are
 * world-readable by design (non-PII — an account code and a timestamp) so the
 * demo persona renders Locked badges; flipping a lock requires a real
 * signed-in HQ admin, mirroring the training editor's author-write rule, and
 * the demo persona gets the same "sign in to make changes" nudge.
 *
 * Live updates ride the proven staff-revocation pattern: a realtime
 * subscription where the publication carries the table, with a poll as the
 * fallback. That is what ejects an already-signed-in staffer mid-session when
 * their office is locked — and what lets the locked screen clear itself the
 * moment the account is unlocked, with nothing re-created.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/contexts/session';

export interface AccountLock {
  accountId: string;
  lockedAt: string;
}

interface AccountLocksValue {
  /** Lock rows by account id; empty while loading or when nothing is locked. */
  locks: ReadonlyMap<string, AccountLock>;
  isLocked: (accountId: string | null | undefined) => boolean;
  /** True when this session may flip locks (a real signed-in HQ admin). */
  canEditLocks: boolean;
  /**
   * Lock or unlock an account. Resolves true when the change landed; demo
   * personas get the standard read-only nudge and false instead.
   */
  setAccountLock: (accountId: string, locked: boolean) => Promise<boolean>;
}

const LOCKS_QUERY_KEY = ['account-locks'] as const;
/** Poll fallback — matches the staff-role refresh cadence in session.tsx. */
const LOCK_POLL_MS = 10_000;

async function fetchLocks(): Promise<AccountLock[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('provider_account_locks')
    .select('account_id, locked_at')
    .limit(1000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    accountId: String(row.account_id),
    lockedAt: String(row.locked_at ?? ''),
  }));
}

const AccountLocksContext = createContext<AccountLocksValue | null>(null);

export function AccountLocksProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { authStatus, authRole } = useSession();
  const canEditLocks = authStatus === 'signed-in' && authRole === 'hq_admin';

  // World-readable and identical for every persona, so one un-partitioned
  // cache entry serves the demo, office staff, and HQ alike.
  const query = useQuery({
    queryKey: LOCKS_QUERY_KEY,
    queryFn: fetchLocks,
    enabled: supabase !== null,
    refetchInterval: LOCK_POLL_MS,
    staleTime: 5_000,
  });

  // Realtime flips beat the poll wherever the publication carries the table.
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel('account-locks-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'provider_account_locks' },
        () => {
          void queryClient.invalidateQueries({ queryKey: LOCKS_QUERY_KEY });
        },
      )
      .subscribe();
    return () => {
      if (supabase) void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Fetch trouble degrades to "nothing locked": this gate is UX — row level
  // security is what actually keeps a locked office's data closed.
  const locks = useMemo(() => {
    const map = new Map<string, AccountLock>();
    for (const lock of query.data ?? []) map.set(lock.accountId, lock);
    return map;
  }, [query.data]);

  const isLocked = useCallback(
    (accountId: string | null | undefined) => (accountId ? locks.has(accountId) : false),
    [locks],
  );

  const setAccountLock = useCallback(
    async (accountId: string, locked: boolean): Promise<boolean> => {
      if (!canEditLocks || !supabase) {
        toast({
          title: 'Sign in to make changes',
          description:
            'The demo persona can browse HQ, but locking an account needs a real THINNR HQ sign-in.',
        });
        return false;
      }
      try {
        if (locked) {
          const { error } = await supabase
            .from('provider_account_locks')
            .insert({ account_id: accountId });
          // 23505 = someone locked it first; that is the state we wanted.
          if (error && error.code !== '23505') throw new Error(error.message);
        } else {
          const { error } = await supabase
            .from('provider_account_locks')
            .delete()
            .eq('account_id', accountId);
          if (error) throw new Error(error.message);
        }
        await queryClient.invalidateQueries({ queryKey: LOCKS_QUERY_KEY });
        return true;
      } catch (error) {
        toast({
          title: 'Change not saved',
          description: error instanceof Error ? error.message : 'Unexpected database error.',
          variant: 'destructive',
        });
        return false;
      }
    },
    [canEditLocks, queryClient],
  );

  const value = useMemo(
    () => ({ locks, isLocked, canEditLocks, setAccountLock }),
    [locks, isLocked, canEditLocks, setAccountLock],
  );

  return <AccountLocksContext.Provider value={value}>{children}</AccountLocksContext.Provider>;
}

export function useAccountLocks(): AccountLocksValue {
  const value = useContext(AccountLocksContext);
  if (!value) throw new Error('useAccountLocks must be used inside AccountLocksProvider');
  return value;
}
