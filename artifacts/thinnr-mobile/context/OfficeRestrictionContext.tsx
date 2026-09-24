/**
 * The narrowed-for-nonpayment state of the signed-in staffer's office.
 *
 * Read once here and shared with the route guard, the provider launcher, and
 * the account screen, so the app offers exactly the surface the server allows.
 * Never narrows on a guess: until the state is known (or if the read fails),
 * the app behaves as a paid office and the server stays the authority.
 */
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppMode } from '@/context/AppModeContext';
import { useSupabaseSession } from '@/lib/supabase';
import { fetchOfficeAccess, payOfficeAccess, type OfficeAccessState } from '@/lib/office-access-api';

export interface OfficeRestrictionValue {
  restricted: boolean;
  message: string | null;
  access: OfficeAccessState | undefined;
  loading: boolean;
}

const OfficeRestrictionContext = createContext<OfficeRestrictionValue>({
  restricted: false,
  message: null,
  access: undefined,
  loading: false,
});

export function officeAccessKey(userId: string | null): readonly unknown[] {
  return ['office-access', userId] as const;
}

export function OfficeRestrictionProvider({ children }: { children: ReactNode }) {
  const { mode, hydrated } = useAppMode();
  const { session, sessionLoading } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const enabled = hydrated && mode === 'staff' && !sessionLoading && Boolean(userId);
  const query = useQuery<OfficeAccessState, Error>({
    queryKey: officeAccessKey(userId),
    queryFn: ({ signal }) => fetchOfficeAccess(userId ? { userId, signal } : undefined),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
  });
  const restricted = query.data?.restricted === true;
  const value = useMemo<OfficeRestrictionValue>(
    () => ({
      restricted,
      message: restricted ? query.data?.message ?? null : null,
      access: query.data,
      loading: query.isPending && enabled,
    }),
    [restricted, query.data, query.isPending, enabled],
  );
  return <OfficeRestrictionContext.Provider value={value}>{children}</OfficeRestrictionContext.Provider>;
}

export function useOfficeRestriction(): OfficeRestrictionValue {
  return useContext(OfficeRestrictionContext);
}

/** Pay the office's THINNR access now. Open to every staff role. */
export function usePayOfficeAccess() {
  const { session } = useSupabaseSession();
  const userId = session?.user?.id ?? null;
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => payOfficeAccess(userId ? { userId } : undefined),
    onSuccess: (data) => {
      client.setQueryData(officeAccessKey(userId), data);
      // Recovery reopens the whole app: nothing cached under the narrowed
      // surface should survive it.
      if (!data.restricted) void client.invalidateQueries();
    },
  });
}
