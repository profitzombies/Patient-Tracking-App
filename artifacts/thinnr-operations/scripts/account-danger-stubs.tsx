import * as React from 'react';

const accounts = new Map([
  ['office-1', {
    id: 'office-1', providerId: 'office-1', officeName: 'Beacon Hill Aesthetics',
    providerName: 'Dr. Beacon', providerRole: 'Physician', providerCode: 'BEACON',
    status: 'active', plan: 'Core', address1: '1 Main St', address2: null,
    city: 'Boston', state: 'MA', postalCode: '02108', email: 'beacon@example.com',
    phone: '6175550100', joinedKey: '2026-01-01', activePatientCount: 3,
  }],
  ['office-2', {
    id: 'office-2', providerId: 'office-2', officeName: 'Harbor Wellness',
    providerName: 'Dr. Harbor', providerRole: 'Physician', providerCode: 'HARBOR',
    status: 'active', plan: 'Plus', address1: '2 State St', address2: null,
    city: 'Boston', state: 'MA', postalCode: '02109', email: 'harbor@example.com',
    phone: '6175550101', joinedKey: '2026-02-01', activePatientCount: 2,
  }],
]);

export class ProviderAccountError extends Error {}
export async function fetchProviderAccountDetail(id: string) {
  const account = accounts.get(id);
  if (!account) throw new ProviderAccountError('not found');
  return { account, roster: [], staff: [] };
}

export function useHqData() {
  return {
    accountsStatus: 'ready',
    findAccount: (id: string) => accounts.get(id),
    updateAccount: async () => undefined,
    canManageProviderAccounts: true,
  };
}

export function useAccountLocks() {
  return {
    locks: new Map(),
    isLocked: () => false,
    setAccountLock: async () => true,
  };
}

export function useSession() {
  return { authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin' };
}

export function useDateRange() {
  return { range: { start: '2026-08-01', end: '2026-08-30' } };
}
export function formatRangeLabel() { return 'Aug 1 – Aug 30, 2026'; }
export function DateRangeControl() { return <span data-testid="stub-date-range" />; }

export function useGetOfficeAnalytics() {
  return { isPending: false, isError: false, data: { available: false }, refetch() {} };
}
export function getGetOfficeAnalyticsQueryKey() { return ['analytics']; }

export function OfficeRangeMetricsGrid() {
  return <div data-testid="stub-range-metrics" />;
}

export function useAccountPayments() { return { tiles: null }; }
export function AccountPaymentsCard({ providerId }: { providerId: string }) {
  return <div data-testid="stub-payments" data-provider-id={providerId} />;
}

export function StaffAccessCard({ account }: { account: { id: string } }) {
  return <div data-testid="stub-staff-access" data-provider-id={account.id}>Staff access</div>;
}

function Draft({ id }: { id: string }) {
  const [value, setValue] = React.useState('');
  return <input data-testid={`draft-${id}`} value={value} onChange={(event) => setValue(event.target.value)} />;
}

export function OfficeOffboarding({ officeId }: { officeId: string }) {
  return <div data-testid="stub-offboarding" data-office-id={officeId}><button type="button" disabled>Offboard</button><Draft id="offboarding" /></div>;
}
export function OfficeBundleExport({ officeId, officeName }: { officeId: string; officeName: string }) {
  return <div data-testid="stub-bundle" data-office-id={officeId} data-office-name={officeName}><button type="button">Export</button><Draft id="bundle" /></div>;
}
export function LegalHoldControls(props: { targetKind: string; targetId: string; providerId: string; label: string }) {
  return <div data-testid="stub-legal-hold" data-target-kind={props.targetKind} data-target-id={props.targetId} data-provider-id={props.providerId} data-label={props.label}><button type="button" disabled>Legal hold</button></div>;
}