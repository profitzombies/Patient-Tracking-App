/**
 * The office workspace navigation, extracted to one shared config so the live
 * Shell and the /menu design lab render the exact same item set — menu
 * redesigns differ in style, never in content.
 *
 * Owns: the item list (labels, routes, icons), active-route detection, and
 * the account-chip identity (name, role, initials) that the Shell header and
 * every lab design consume. Sign-out itself stays with useSession().signOut.
 */
import {
  Box,
  GraduationCap,
  LayoutDashboard,
  Settings,
  Sparkles,
  Trophy,
  Users,
  WalletCards,
  type LucideIcon,
} from 'lucide-react';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';

export interface OfficeNavItem {
  path: string;
  label: string;
  /** Short label for the phone tab bar (Revenue & Outcomes → Outcomes). */
  mobileLabel: string;
  icon: LucideIcon;
}

export const OFFICE_NAV_ITEMS: OfficeNavItem[] = [
  { path: '/', label: 'Overview', mobileLabel: 'Overview', icon: LayoutDashboard },
  { path: '/patients', label: 'Patients', mobileLabel: 'Patients', icon: Users },
  { path: '/analytics', label: 'Revenue & Outcomes', mobileLabel: 'Outcomes', icon: WalletCards },
  { path: '/leaderboard', label: 'Leaderboard', mobileLabel: 'Leaderboard', icon: Trophy },
  { path: '/subscriptions', label: 'Subscriptions', mobileLabel: 'Plans', icon: Box },
  { path: '/training', label: 'Training', mobileLabel: 'Training', icon: GraduationCap },
  { path: '/ai-support', label: 'AI Support', mobileLabel: 'Support', icon: Sparkles },
];

/**
 * Reached from the header gear, not the menu: the office Settings page shows
 * the effective organization policy and the office's own overrides. It lives
 * outside OFFICE_NAV_ITEMS so no menu design grows an extra tab, but the
 * header title and document title still resolve it.
 */
export const OFFICE_SETTINGS_NAV_ITEM: OfficeNavItem = { path: '/settings', label: 'Settings', mobileLabel: 'Settings', icon: Settings };

/** The Porcelain menu's section grouping, shared by the live Shell and the lab. */
export const OFFICE_NAV_SECTION_DEFS = [
  { label: 'Dashboard', paths: ['/'] },
  { label: 'Operations', paths: ['/patients', '/subscriptions'] },
  { label: 'Insights', paths: ['/analytics', '/leaderboard'] },
  { label: 'Learning', paths: ['/training', '/ai-support'] },
];

/** Overview is an exact match; every other section owns its subtree. */
export function isOfficeNavItemActive(itemPath: string, location: string): boolean {
  if (itemPath === '/') return location === '/';
  return location.startsWith(itemPath);
}

export function findActiveOfficeNavItem(location: string): OfficeNavItem {
  return (
    OFFICE_NAV_ITEMS.find((item) => isOfficeNavItemActive(item.path, location)) ??
    (isOfficeNavItemActive(OFFICE_SETTINGS_NAV_ITEM.path, location) ? OFFICE_SETTINGS_NAV_ITEM : OFFICE_NAV_ITEMS[0])
  );
}

/** Initials for the identity chip, skipping honorifics/credentials. */
const NAME_NOISE = new Set(['dr', 'mr', 'mrs', 'ms', 'np', 'rn', 'md', 'pa', 'do']);
export function initialsOf(name: string): string {
  const parts = name
    .split(/[\s,]+/)
    .filter((word) => word && !NAME_NOISE.has(word.replace(/\./g, '').toLowerCase()));
  return parts.map((word) => word[0]?.toUpperCase() ?? '').slice(0, 2).join('') || 'TH';
}

export interface OfficeIdentity {
  accountName: string;
  accountRole: string;
  initials: string;
  /** Brand-area subtitle: the scoped office, or the demo operations desk. */
  workspaceLabel: string;
}

/**
 * The account chip shows the real signed-in staffer when there is one; the
 * demo persona and the HQ drill-in keep their seeded identities.
 */
export function useOfficeIdentity(): OfficeIdentity {
  const scope = useProviderScope();
  const { authStatus, authRole, authUser } = useSession();
  const isRealStaff = authStatus === 'signed-in' && authRole === 'provider_staff' && authUser !== null;
  const accountName = isRealStaff
    ? (authUser.displayName ?? 'Office staff')
    : scope
      ? scope.providerName
      : 'Dr. Sarah Jenkins';
  const accountRole = isRealStaff
    ? (scope?.officeName ?? 'Office staff')
    : scope
      ? scope.providerRole
      : 'Medical Director';
  return {
    accountName,
    accountRole,
    initials: initialsOf(accountName),
    workspaceLabel: scope ? scope.officeName : 'operations desk',
  };
}
