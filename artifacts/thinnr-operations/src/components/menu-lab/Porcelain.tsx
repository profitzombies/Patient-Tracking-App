import { Plus } from 'lucide-react';
import {
  isOfficeNavItemActive,
  OFFICE_NAV_SECTION_DEFS,
} from '@/components/layout/nav-config';
import { groupMenuSections, SideMenu } from '@/components/layout/side-menu';
import type { MenuDesignProps } from './types';

/**
 * Option 6 — Porcelain. The chosen direction, now the live app menu.
 *
 * This preview is a thin adapter over the shared SideMenu component the real
 * Shell and AdminShell render, wired to the lab's simulated callbacks — so
 * what the lab shows is exactly what the product ships.
 */
export function Porcelain({
  mode,
  items,
  activePath,
  onSelect,
  patientCount,
  workspaceLabel,
  accountName,
  accountRole,
  accountInitials,
  onSettings,
  onSignOut,
  onModeChange,
}: MenuDesignProps) {
  const sections = groupMenuSections(items, OFFICE_NAV_SECTION_DEFS).map((section) => ({
    label: section.label,
    items: section.items.map((item) => ({
      path: item.path,
      label: item.label,
      icon: item.icon,
      count: item.path === '/patients' ? patientCount : undefined,
    })),
  }));

  return (
    <SideMenu
      label="Porcelain menu preview"
      mode={mode}
      onModeChange={(next) => onModeChange?.(next)}
      sections={sections}
      isItemActive={(path) => isOfficeNavItemActive(path, activePath)}
      onSelect={onSelect}
      brandSubtitle={workspaceLabel}
      cta={{ label: 'Add patient', icon: Plus, onClick: () => onSelect('/patients') }}
      accountName={accountName}
      accountRole={accountRole}
      accountInitials={accountInitials}
      onSignOut={onSignOut}
      onSettings={onSettings}
    />
  );
}
