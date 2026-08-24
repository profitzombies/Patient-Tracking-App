/**
 * Session-mutable HQ data: provider accounts, the THINNR team, and org
 * settings values.
 *
 * There is no server — edits live in React state and mirror into
 * sessionStorage so they persist across reloads for this tab's demo session
 * and vanish when the tab closes. Seeded accounts are never mutated; adding
 * an account appends a fresh 'pending' sub-account with zeroed metrics (it
 * has no patients yet, so every HQ rollup stays consistent with the office
 * demo's program totals by construction).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  NEW_ACCOUNT_CODE_POOL,
  SEEDED_ACCOUNTS,
  type AccountPlan,
  type ProviderAccount,
} from '@/data/hq/accounts';
import { SEEDED_TEAM, type HqRole, type HqTeamMember } from '@/data/hq/team';
import { defaultSettingsValues, type HqSettingValue } from '@/data/hq/settings';
import { TODAY_KEY } from '@/data/nutrition-data';

const STORAGE_KEY = 'thinnr-hq-session-v1';

export interface NewAccountInput {
  officeName: string;
  providerName: string;
  providerRole: string;
  city: string;
  state: string;
  plan: AccountPlan;
  email: string;
  phone: string;
}

export interface InviteInput {
  name: string;
  email: string;
  role: HqRole;
  title: string;
}

interface StoredHqState {
  addedAccounts: ProviderAccount[];
  team: HqTeamMember[];
  settingsValues: Record<string, HqSettingValue>;
}

/** Best-effort restore; any malformed blob falls back to seeds. */
function readStoredState(): StoredHqState {
  const fallback: StoredHqState = { addedAccounts: [], team: SEEDED_TEAM, settingsValues: defaultSettingsValues() };
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredHqState>;
    return {
      addedAccounts: Array.isArray(parsed.addedAccounts) ? parsed.addedAccounts : [],
      team: Array.isArray(parsed.team) && parsed.team.length > 0 ? parsed.team : SEEDED_TEAM,
      settingsValues: { ...defaultSettingsValues(), ...(parsed.settingsValues ?? {}) },
    };
  } catch {
    return fallback;
  }
}

interface HqDataValue {
  /** Seeded sub-accounts plus any added this session. */
  accounts: ProviderAccount[];
  findAccount: (id: string | undefined) => ProviderAccount | undefined;
  addAccount: (input: NewAccountInput) => ProviderAccount;
  team: HqTeamMember[];
  inviteTeamMember: (input: InviteInput) => void;
  updateTeamMember: (id: string, patch: { role?: HqRole; title?: string }) => void;
  removeTeamMember: (id: string) => void;
  settingsValues: Record<string, HqSettingValue>;
  saveSettings: (patch: Record<string, HqSettingValue>) => void;
}

const HqDataContext = createContext<HqDataValue | null>(null);

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || 'TH';

export function HqDataProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredHqState>(readStoredState);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Storage may be unavailable (privacy modes); in-memory state still works.
    }
  }, [stored]);

  const accounts = useMemo(() => [...SEEDED_ACCOUNTS, ...stored.addedAccounts], [stored.addedAccounts]);

  const findAccount = useCallback(
    (id: string | undefined) => accounts.find((account) => account.id === id),
    [accounts],
  );

  const addAccount = useCallback(
    (input: NewAccountInput): ProviderAccount => {
      const usedCodes = new Set([...SEEDED_ACCOUNTS, ...stored.addedAccounts].map((account) => account.providerCode));
      const providerCode =
        NEW_ACCOUNT_CODE_POOL.find((code) => !usedCodes.has(code)) ??
        // Pool exhausted (7+ adds in one session): derive a stable spare from the count.
        String(700000 + stored.addedAccounts.length * 1111 + 137).slice(0, 6);
      const account: ProviderAccount = {
        id: `acct-new-${stored.addedAccounts.length + 1}`,
        providerId: null,
        officeName: input.officeName,
        providerName: input.providerName,
        providerRole: input.providerRole,
        providerCode,
        status: 'pending',
        plan: input.plan,
        city: input.city,
        state: input.state,
        email: input.email,
        phone: input.phone,
        // New accounts join "today" — the fixed demo anchor, never the viewer clock.
        joinedKey: TODAY_KEY,
        greetingName: input.providerName.split(/\s+/)[0] ?? input.providerName,
        activePatientCount: 0,
        newEnrollments: 0,
        recurringRevenue: 0,
        enrollmentRevenue: 0,
        activeSubscriptions: 0,
        deliveriesInWindow: 0,
        engagementRate: 0,
        avgPoundsLost: 0,
        goalCompletion: 0,
        retention: 0,
      };
      setStored((current) => ({ ...current, addedAccounts: [...current.addedAccounts, account] }));
      return account;
    },
    [stored.addedAccounts],
  );

  const inviteTeamMember = useCallback((input: InviteInput) => {
    setStored((current) => ({
      ...current,
      team: [
        ...current.team,
        {
          id: `hq-invite-${current.team.length + 1}`,
          name: input.name,
          initials: initialsOf(input.name),
          role: input.role,
          title: input.title,
          email: input.email,
          status: 'invited',
          // Anchored to the demo date — invites always read as "today" at HQ.
          joinedLabel: 'Aug 2026',
        },
      ],
    }));
  }, []);

  const updateTeamMember = useCallback((id: string, patch: { role?: HqRole; title?: string }) => {
    setStored((current) => ({
      ...current,
      team: current.team.map((member) => (member.id === id ? { ...member, ...patch } : member)),
    }));
  }, []);

  const removeTeamMember = useCallback((id: string) => {
    setStored((current) => ({
      ...current,
      // The Owner seat is not removable in the demo — the UI disables it, and
      // this guard keeps a stray call from orphaning the org.
      team: current.team.filter((member) => member.id !== id || member.role === 'Owner'),
    }));
  }, []);

  const saveSettings = useCallback((patch: Record<string, HqSettingValue>) => {
    setStored((current) => ({ ...current, settingsValues: { ...current.settingsValues, ...patch } }));
  }, []);

  const value = useMemo(
    () => ({
      accounts,
      findAccount,
      addAccount,
      team: stored.team,
      inviteTeamMember,
      updateTeamMember,
      removeTeamMember,
      settingsValues: stored.settingsValues,
      saveSettings,
    }),
    [accounts, findAccount, addAccount, stored.team, inviteTeamMember, updateTeamMember, removeTeamMember, stored.settingsValues, saveSettings],
  );

  return <HqDataContext.Provider value={value}>{children}</HqDataContext.Provider>;
}

export function useHqData() {
  const context = useContext(HqDataContext);
  if (!context) throw new Error('useHqData must be used within HqDataProvider');
  return context;
}
