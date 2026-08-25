import type { OfficeNavItem } from '@/components/layout/nav-config';

/** Pinned keeps the menu expanded; hover retracts it to a slim icon rail. */
export type RailMode = 'pinned' | 'hover';

/**
 * Every lab design is a pure presentation of the same shared content: the
 * real item list, the active route, the brand area, and the account chip.
 * The lab wires callbacks to simulated (preview-only) behaviors.
 */
export interface MenuDesignProps {
  mode: RailMode;
  items: OfficeNavItem[];
  activePath: string;
  onSelect: (path: string) => void;
  patientCount: number;
  workspaceLabel: string;
  accountName: string;
  accountRole: string;
  accountInitials: string;
  onSettings: () => void;
  onSignOut: () => void;
}
