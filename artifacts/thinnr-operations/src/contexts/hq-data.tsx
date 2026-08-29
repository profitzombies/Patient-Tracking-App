/**
 * HQ shared state. Provider accounts are live server data; the unrelated HQ
 * team/settings demo controls retain their existing session behavior.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderAccount } from '@/data/hq/accounts';
import {
  createProviderAccount,
  fetchProviderAccounts,
  type NewProviderAccountInput,
} from '@/lib/provider-accounts';
import { SEEDED_TEAM, type HqRole, type HqTeamMember } from '@/data/hq/team';
import { defaultSettingsValues, type HqSettingValue } from '@/data/hq/settings';
import { useSession } from '@/contexts/session';

const STORAGE_KEY = 'thinnr-hq-ui-session-v2';
export const PROVIDER_ACCOUNTS_QUERY_KEY = ['provider-accounts'] as const;

export type NewAccountInput = NewProviderAccountInput;
export interface InviteInput { name: string; email: string; role: HqRole; title: string }
interface StoredUiState {
  team: HqTeamMember[];
  settingsValues: Record<string, HqSettingValue>;
}

function readStoredState(): StoredUiState {
  const fallback = { team: SEEDED_TEAM, settingsValues: defaultSettingsValues() };
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<StoredUiState>;
    return {
      team: Array.isArray(parsed.team) && parsed.team.length > 0 ? parsed.team : SEEDED_TEAM,
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
  inviteTeamMember: (input: InviteInput) => void;
  updateTeamMember: (id: string, patch: { role?: HqRole; title?: string }) => void;
  removeTeamMember: (id: string) => void;
  settingsValues: Record<string, HqSettingValue>;
  saveSettings: (patch: Record<string, HqSettingValue>) => void;
}

const HqDataContext = createContext<HqDataValue | null>(null);
const initialsOf = (name: string) =>
  name.split(/\s+/).filter((word) => /^[A-Za-z]/.test(word)).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('') || 'TH';

export function HqDataProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredUiState>(readStoredState);
  const queryClient = useQueryClient();
  const { authStatus, authRole } = useSession();
  const canReadLiveAccounts = authStatus === 'signed-in' && authRole === 'hq_admin';
  const query = useQuery({
    queryKey: PROVIDER_ACCOUNTS_QUERY_KEY,
    queryFn: fetchProviderAccounts,
    enabled: canReadLiveAccounts,
    staleTime: 15_000,
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
    const created = await createProviderAccount(input);
    queryClient.setQueryData<ProviderAccount[]>(PROVIDER_ACCOUNTS_QUERY_KEY, (current = []) => [
      ...current.filter((row) => row.id !== created.account.id),
      created.account,
    ]);
    return created;
  }, [queryClient]);

  const inviteTeamMember = useCallback((input: InviteInput) => setStored((current) => ({
    ...current,
    team: [...current.team, {
      id: `hq-invite-${current.team.length + 1}`,
      name: input.name, initials: initialsOf(input.name), role: input.role,
      title: input.title, email: input.email, status: 'invited', joinedLabel: 'Aug 2026',
    }],
  })), []);
  const updateTeamMember = useCallback((id: string, patch: { role?: HqRole; title?: string }) =>
    setStored((current) => ({ ...current, team: current.team.map((member) => member.id === id ? { ...member, ...patch } : member) })), []);
  const removeTeamMember = useCallback((id: string) =>
    setStored((current) => ({ ...current, team: current.team.filter((member) => member.id !== id || member.role === 'Owner') })), []);
  const saveSettings = useCallback((patch: Record<string, HqSettingValue>) =>
    setStored((current) => ({ ...current, settingsValues: { ...current.settingsValues, ...patch } })), []);

  const value = useMemo<HqDataValue>(() => ({
    accounts,
    accountsStatus: !canReadLiveAccounts ? 'unauthorized' : query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
    accountsError: query.error instanceof Error ? query.error.message : null,
    refreshAccounts,
    findAccount,
    addAccount,
    team: stored.team,
    inviteTeamMember,
    updateTeamMember,
    removeTeamMember,
    settingsValues: stored.settingsValues,
    saveSettings,
  }), [accounts, canReadLiveAccounts, query.isPending, query.isError, query.error, refreshAccounts, findAccount, addAccount, stored, inviteTeamMember, updateTeamMember, removeTeamMember, saveSettings]);

  return <HqDataContext.Provider value={value}>{children}</HqDataContext.Provider>;
}

export function useHqData() {
  const context = useContext(HqDataContext);
  if (!context) throw new Error('useHqData must be used within HqDataProvider');
  return context;
}