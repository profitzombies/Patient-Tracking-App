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
  ClipboardList,
  CreditCard,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserCog,
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
  /** Dropdown sub-destinations under the row (desktop menu only; phones use the in-area tabs). */
  children?: Array<{ path: string; label: string }>;
}

/**
 * The office Payments area, section by section. Owners and admins see the
 * same sub-pages HQ does, scoped to their office: mostly status views, plus
 * the two things an office actually does here (refund a payment, set prices).
 */
export const OFFICE_PAYMENTS_SECTIONS = [
  { path: '/payments', label: 'Overview' },
  { path: '/payments/activity', label: 'Activity' },
  { path: '/payments/transactions', label: 'Transactions' },
  { path: '/payments/refunds', label: 'Refunds' },
  { path: '/payments/fulfillment', label: 'Fulfillment' },
  { path: '/payments/subscriptions', label: 'Subscriptions' },
  { path: '/payments/payouts', label: 'Payouts' },
  { path: '/payments/links', label: 'Payment links' },
  { path: '/payments/prices', label: 'Prices' },
  { path: '/payments/settings', label: 'Settings' },
] as const;

export const OFFICE_NAV_ITEMS: OfficeNavItem[] = [
  { path: '/', label: 'Overview', mobileLabel: 'Overview', icon: LayoutDashboard },
  { path: '/patients', label: 'Patients', mobileLabel: 'Patients', icon: Users },
  { path: '/conversations', label: 'Conversations', mobileLabel: 'Inbox', icon: MessagesSquare },
  { path: '/analytics', label: 'Revenue & Outcomes', mobileLabel: 'Outcomes', icon: WalletCards },
  { path: '/leaderboard', label: 'Leaderboard', mobileLabel: 'Leaderboard', icon: Trophy },
  { path: '/subscriptions', label: 'Subscriptions', mobileLabel: 'Plans', icon: Box },
  { path: '/payments', label: 'Payments', mobileLabel: 'Payments', icon: CreditCard, children: [...OFFICE_PAYMENTS_SECTIONS] },
  { path: '/training', label: 'Training', mobileLabel: 'Training', icon: GraduationCap },
  { path: '/files', label: 'Files', mobileLabel: 'Files', icon: FolderOpen },
  { path: '/ai-support', label: 'AI Support', mobileLabel: 'Support', icon: Sparkles },
  { path: '/team', label: 'Team', mobileLabel: 'Team', icon: UserCog },
  { path: '/audit', label: 'Audit trail', mobileLabel: 'Audit', icon: ClipboardList },
  { path: '/security', label: 'Security', mobileLabel: 'Security', icon: ShieldCheck },
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
  { label: 'Operations', paths: ['/patients', '/conversations', '/subscriptions', '/payments'] },
  { label: 'Insights', paths: ['/analytics', '/leaderboard'] },
  { label: 'Learning', paths: ['/training', '/files', '/ai-support'] },
  { label: 'Administration', paths: ['/team', '/audit', '/security'] },
];

/** Overview is an exact match; every other section owns its subtree. */
export function isOfficeNavItemActive(itemPath: string, location: string): boolean {
  if (itemPath === '/') return location === '/';
  return location.startsWith(itemPath);
}

/**
 * Side-menu matcher that understands dropdown children: the parent row is
 * active anywhere in its subtree, a child only on its own page (Overview
 * children that equal the parent path light only on the exact page).
 */
export function isOfficeMenuPathActive(path: string, location: string): boolean {
  const parent = OFFICE_NAV_ITEMS.find((item) => item.children?.some((child) => child.path === path && child.path !== item.path));
  if (parent) return location === path || location.startsWith(`${path}/`);
  return isOfficeNavItemActive(path, location);
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
