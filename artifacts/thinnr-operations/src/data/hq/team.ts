export type HqRole = 'Super Admin' | 'Admin' | 'Clinical' | 'Support' | 'Content';

export interface HqTeamMember {
  id: string;
  authUserId?: string | null;
  name: string;
  initials: string;
  role: HqRole;
  title: string | null;
  email: string;
  status: 'active' | 'pending';
  joinedLabel: string;
  secondFactorPhone?: string | null;
}

export const HQ_ROLE_NOTES: Record<HqRole, string> = {
  'Super Admin': 'Protected owner access with full control. This role cannot be invited, changed, or removed here.',
  Admin: 'Full HQ access, including team, provider accounts, and settings.',
  Clinical: 'Provider accounts, clinical information, analytics, and coach conversations.',
  Support: 'Provider account contact and status information, plus support conversations.',
  Content: 'Training, AI Support knowledge, and shared content management.',
};

export type HqPermission =
  | 'overview'
  | 'accounts'
  | 'conversations'
  | 'escalations'
  | 'team'
  | 'training'
  | 'knowledge'
  | 'files'
  | 'settings'
  | 'audit'
  | 'exports'
  | 'payments';

/** The UI mirrors the server authorization model; the API remains authoritative. */
export const HQ_ROLE_PERMISSIONS: Record<HqRole, ReadonlySet<HqPermission>> = {
  'Super Admin': new Set(['overview', 'accounts', 'conversations', 'escalations', 'team', 'training', 'knowledge', 'files', 'settings', 'audit', 'exports', 'payments']),
  Admin: new Set(['overview', 'accounts', 'conversations', 'escalations', 'team', 'training', 'knowledge', 'files', 'settings', 'audit', 'exports', 'payments']),
  // Every department has at least one export kind (the API narrows the list per role).
  Clinical: new Set(['accounts', 'conversations', 'escalations', 'exports']),
  Support: new Set(['accounts', 'conversations', 'escalations', 'exports']),
  Content: new Set(['training', 'knowledge', 'files', 'exports']),
};

export const INVITABLE_HQ_ROLES: HqRole[] = ['Admin', 'Clinical', 'Support', 'Content'];

export function canHq(role: HqRole | null, permission: HqPermission): boolean {
  return role !== null && HQ_ROLE_PERMISSIONS[role].has(permission);
}

export function permissionForAdminPath(path: string): HqPermission {
  // App usage and Patient retention are analytics: the same gate as the overview / office comparison.
  if (path.startsWith('/admin/app-usage') || path.startsWith('/admin/patient-retention')) return 'overview';
  if (path.startsWith('/admin/payments')) return 'payments';
  if (path.startsWith('/admin/accounts')) return 'accounts';
  if (path.startsWith('/admin/conversations')) return 'conversations';
  if (path.startsWith('/admin/escalations')) return 'escalations';
  if (path.startsWith('/admin/team')) return 'team';
  if (path.startsWith('/admin/training')) return 'training';
  if (path.startsWith('/admin/knowledge') || path.startsWith('/admin/support-test')) return 'knowledge';
  if (path.startsWith('/admin/audit')) return 'audit';
  if (path.startsWith('/admin/files')) return 'files';
  if (path.startsWith('/admin/exports')) return 'exports';
  if (path.startsWith('/admin/settings') || path.startsWith('/admin/system-health')) return 'settings';
  return 'overview';
}

export function firstAllowedAdminPath(role: HqRole): string {
  if (canHq(role, 'overview')) return '/admin';
  if (canHq(role, 'accounts')) return '/admin/accounts';
  if (canHq(role, 'training')) return '/admin/training';
  return '/admin';
}
