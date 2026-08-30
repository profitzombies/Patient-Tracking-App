/**
 * HQ shared state. Provider accounts are live server data; the unrelated HQ
 * team/settings demo controls retain their existing session behavior.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderAccount } from '@/data/hq/accounts';
import {
  createProviderAccount,
  fetchProviderAccounts,
  type NewProviderAccountInput,
} from '@/lib/provider-accounts';
import type { HqRole, HqTeamMember } from '@/data/hq/team';
import { canHq } from '@/data/hq/team';
import {
  fetchHqTeam,
  inviteHqTeamMember as inviteHqTeamMemberRequest,
  removeHqTeamMember as removeHqTeamMemberRequest,
  updateHqTeamMember as updateHqTeamMemberRequest,
  type InviteHqTeamMemberInput,
} from '@/lib/hq-team';
import { defaultSettingsValues, type HqSettingValue } from '@/data/hq/settings';
import { useSession } from '@/contexts/session';

const STORAGE_KEY = 'thinnr-hq-ui-session-v2';
export const PROVIDER_ACCOUNTS_QUERY_KEY = ['provider-accounts'] as const;
export const HQ_TEAM_QUERY_KEY = ['hq-team'] as const;

export type NewAccountInput = NewProviderAccountInput;
interface StoredUiState {
  settingsValues: Record<string, HqSettingValue>;
}

function readStoredState(): StoredUiState {
  const fallback = { settingsValues: defaultSettingsValues() };
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<StoredUiState>;
    return {
      settingsValues: { ...defaultSettingsValues(), ...(parsed.settingsValues ?? {}) },
    };
  } catch {
    return fallback;
  }
}

interface HqDataValue {
  accounts: ProviderAccount[];
  accountsStatus: 'loading' | 'ready' | 'error' | 'unauthorized';
  accountsError: string | null;
  refreshAccounts: () => Promise<void>;
  findAccount: (id: string | undefined) => ProviderAccount | undefined;
  addAccount: (input: NewAccountInput) => ReturnType<typeof createProviderAccount>;
  team: HqTeamMember[];
  teamStatus: 'loading' | 'ready' | 'error' | 'unauthorized';
  teamError: string | null;
  inviteTeamMember: (input: InviteHqTeamMemberInput) => ReturnType<typeof inviteHqTeamMemberRequest>;
  updateTeamMember: (id: string, patch: { role: Exclude<HqRole, 'Super Admin'>; title: string }) => Promise<HqTeamMember>;
  removeTeamMember: (id: string) => Promise<void>;
  teamMutationPending: boolean;
  settingsValues: Record<string, HqSettingValue>;
  saveSettings: (patch: Record<string, HqSettingValue>) => void;
}

const HqDataContext = createContext<HqDataValue | null>(null);
export function HqDataProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredUiState>(readStoredState);
  const queryClient = useQueryClient();
  const { authStatus, authRole, hqRole } = useSession();
  // The API deliberately returns a contact-only DTO to Support. Keep each
  // role in its own cache entry so a previously cached Admin response can
  // never be displayed after a Support sign-in.
  const canReadLiveAccounts = authStatus === 'signed-in' && authRole === 'hq_admin' && canHq(hqRole, 'accounts');
  const canManageProviderAccounts = authStatus === 'signed-in' && authRole === 'hq_admin' &&
    (hqRole === 'Super Admin' || hqRole === 'Admin');
  const providerAccountsQueryKey = [...PROVIDER_ACCOUNTS_QUERY_KEY, hqRole] as const;
  const query = useQuery({
    queryKey: providerAccountsQueryKey,
    queryFn: fetchProviderAccounts,
    enabled: canReadLiveAccounts,
    staleTime: 15_000,
  });
  const canManageTeam = authStatus === 'signed-in' && authRole === 'hq_admin' &&
    (hqRole === 'Super Admin' || hqRole === 'Admin');
  const teamQuery = useQuery({
    queryKey: HQ_TEAM_QUERY_KEY,
    queryFn: fetchHqTeam,
    enabled: canManageTeam,
    staleTime: 10_000,
    refetchOnWindowFocus: 'always',
  });
  const inviteMutation = useMutation({
    mutationFn: inviteHqTeamMemberRequest,
    onSuccess: ({ member }) => queryClient.setQueryData<HqTeamMember[]>(HQ_TEAM_QUERY_KEY, (current = []) => [
      ...current.filter((row) => row.id !== member.id),
      member,
    ]),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { role: Exclude<HqRole, 'Super Admin'>; title: string } }) =>
      updateHqTeamMemberRequest(id, patch),
    onSuccess: (member) => queryClient.setQueryData<HqTeamMember[]>(HQ_TEAM_QUERY_KEY, (current = []) =>
      current.map((row) => row.id === member.id ? member : row)),
  });
  const removeMutation = useMutation({
    mutationFn: removeHqTeamMemberRequest,
    onSuccess: (_result, id) => queryClient.setQueryData<HqTeamMember[]>(HQ_TEAM_QUERY_KEY, (current = []) =>
      current.filter((row) => row.id !== id)),
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // In-memory controls still work when session storage is unavailable.
    }
  }, [stored]);

  const accounts = query.data ?? [];
  const findAccount = useCallback(
    (id: string | undefined) => accounts.find((account) => account.id === id),
    [accounts],
  );
  const refreshAccounts = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: PROVIDER_ACCOUNTS_QUERY_KEY });
  }, [queryClient]);
  const addAccount = useCallback(async (input: NewAccountInput) => {
    if (!canManageProviderAccounts) {
      throw new Error('Your HQ role cannot create provider accounts.');
    }
    const created = await createProviderAccount(input);
    queryClient.setQueryData<ProviderAccount[]>(providerAccountsQueryKey, (current = []) => [
      ...current.filter((row) => row.id !== created.account.id),
      created.account,
    ]);
    return created;
  }, [canManageProviderAccounts, queryClient, providerAccountsQueryKey]);

  const inviteTeamMember = useCallback((input: InviteHqTeamMemberInput) => inviteMutation.mutateAsync(input), [inviteMutation]);
  const updateTeamMember = useCallback(
    (id: string, patch: { role: Exclude<HqRole, 'Super Admin'>; title: string }) =>
      updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );
  const removeTeamMember = useCallback((id: string) => removeMutation.mutateAsync(id), [removeMutation]);
  const saveSettings = useCallback((patch: Record<string, HqSettingValue>) =>
    setStored((current) => ({ ...current, settingsValues: { ...current.settingsValues, ...patch } })), []);

  const value = useMemo<HqDataValue>(() => ({
    accounts,
    accountsStatus: !canReadLiveAccounts ? 'unauthorized' : query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
    accountsError: query.error instanceof Error ? query.error.message : null,
    refreshAccounts,
    findAccount,
    addAccount,
    team: teamQuery.data ?? [],
    teamStatus: !canManageTeam ? 'unauthorized' : teamQuery.isPending ? 'loading' : teamQuery.isError ? 'error' : 'ready',
    teamError: teamQuery.error instanceof Error ? teamQuery.error.message : null,
    inviteTeamMember,
    updateTeamMember,
    removeTeamMember,
    teamMutationPending: inviteMutation.isPending || updateMutation.isPending || removeMutation.isPending,
    settingsValues: stored.settingsValues,
    saveSettings,
  }), [accounts, canReadLiveAccounts, query.isPending, query.isError, query.error, refreshAccounts, findAccount, addAccount, teamQuery.data, teamQuery.isPending, teamQuery.isError, teamQuery.error, canManageTeam, inviteTeamMember, updateTeamMember, removeTeamMember, inviteMutation.isPending, updateMutation.isPending, removeMutation.isPending, stored.settingsValues, saveSettings]);

  return <HqDataContext.Provider value={value}>{children}</HqDataContext.Provider>;
}

export function useHqData() {
  const context = useContext(HqDataContext);
  if (!context) throw new Error('useHqData must be used within HqDataProvider');
  return context;
}