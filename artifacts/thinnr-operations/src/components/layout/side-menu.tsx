/**
 * The Porcelain side menu — the white console chosen from the /menu design
 * lab, promoted to the live product. One component serves three callers (the
 * office Shell, the HQ AdminShell, and the lab's Porcelain preview) so the
 * approved design cannot drift between them.
 *
 * Behavior: `pinned` keeps the 264px menu in-flow; `hover` keeps a 68px icon
 * rail in-flow and expands the full menu as an overlay on pointer or keyboard
 * focus. Every block sizes fluidly against the rail width — at 68px the menu
 * is a tidy column of 44px icon boxes with symmetric margins (nothing sliced
 * off at a clip edge), and hairline dividers keep the sections organized in
 * both states. Escape collapses the hover overlay.
 */
import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import {
  LogOut,
  MousePointer2,
  Pin,
  Settings2,
  type LucideIcon,
} from 'lucide-react';

export type RailMode = 'pinned' | 'hover';

export const MENU_RAIL_WIDTH = 68;
export const MENU_EXPANDED_WIDTH = 264;

const MENU_MODE_STORAGE_KEY = 'thinnr-menu-mode';

/** The pinned/hover preference, shared by every dashboard and remembered. */
export function useMenuMode(): [RailMode, (mode: RailMode) => void] {
  const [mode, setMode] = useState<RailMode>(() => {
    try {
      if (typeof window === 'undefined') return 'pinned';
      return window.localStorage.getItem(MENU_MODE_STORAGE_KEY) === 'hover' ? 'hover' : 'pinned';
    } catch {
      return 'pinned';
    }
  });
  const update = useCallback((next: RailMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MENU_MODE_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode) — the choice just won't stick.
    }
  }, []);
  return [mode, update];
}

export interface SideMenuItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Small counter chip (e.g. roster size). */
  count?: number;
  /** Small uppercase tag chip (e.g. "Preview"). */
  tag?: string;
  testId?: string;
}

export interface SideMenuSection {
  label: string;
  items: SideMenuItem[];
}

export interface MenuSectionDef {
  label: string;
  paths: string[];
}

/** Groups a flat item list into labeled sections; unknown paths keep a home. */
export function groupMenuSections<T extends { path: string }>(
  items: T[],
  defs: MenuSectionDef[],
): Array<{ label: string; items: T[] }> {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const used = new Set<string>();
  const sections: Array<{ label: string; items: T[] }> = [];
  for (const def of defs) {
    const grouped: T[] = [];
    for (const path of def.paths) {
      const item = byPath.get(path);
      if (item) {
        grouped.push(item);
        used.add(path);
      }
    }
    if (grouped.length > 0) sections.push({ label: def.label, items: grouped });
  }
  const leftovers = items.filter((item) => !used.has(item.path));
  if (leftovers.length > 0) sections.push({ label: 'More', items: leftovers });
  return sections;
}

interface SideMenuProps {
  mode: RailMode;
  onModeChange: (mode: RailMode) => void;
  sections: SideMenuSection[];
  isItemActive: (path: string) => boolean;
  /** Lab previews pass onSelect to simulate navigation; live menus omit it and rows render real links. */
  onSelect?: (path: string) => void;
  brandSubtitle: string;
  cta?: { label: string; icon: LucideIcon; href?: string; onClick?: () => void };
  accountName: string;
  accountRole: string;
  accountInitials: string;
  /** Omit to hide the sign-out control (the HQ drill-in exits via its banner). */
  onSignOut?: () => void;
  /** Omit to hide the settings gear beside the mode pill. */
  onSettings?: () => void;
  /** Accessible name for the aside landmark. */
  label?: string;
}

const ROW_BASE =
  'flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function MenuRow({
  item,
  active,
  onSelect,
}: {
  item: SideMenuItem;
  active: boolean;
  onSelect?: (path: string) => void;
}) {
  const className = `${ROW_BASE} ${
    active
      ? 'bg-primary font-semibold text-white shadow-xs'
      : 'text-[#5c6b81] hover:bg-[#f0f3f8] hover:text-navy'
  }`;
  const inner = (
    <>
      <span className={`grid w-11 shrink-0 place-items-center ${active ? 'text-white' : 'text-[#7d8ca3]'}`}>
        <item.icon size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && (
        <span
          className={`ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${
            active ? 'bg-white/20 text-white' : 'bg-[#eef2f8] text-primary'
          }`}
        >
          {item.count}
        </span>
      )}
      {item.tag && (
        <span className="ml-auto rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-[#b65c22]">
          {item.tag}
        </span>
      )}
    </>
  );
  if (onSelect) {
    return (
      <button
        type="button"
        data-testid={item.testId}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(item.path)}
        className={className}
      >
        {inner}
      </button>
    );
  }
  return (
    <Link
      href={item.path}
      data-testid={item.testId}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {inner}
    </Link>
  );
}

function MenuColumn({
  props,
  expanded,
  onModeToggle,
}: {
  props: SideMenuProps;
  expanded: boolean;
  onModeToggle: () => void;
}) {
  const {
    mode,
    sections,
    isItemActive,
    onSelect,
    brandSubtitle,
    cta,
    accountName,
    accountRole,
    accountInitials,
    onSignOut,
    onSettings,
  } = props;
  const CtaIcon = cta?.icon;

  return (
    <>
      {/* Workspace card */}
      <div className="px-3 pt-3">
        <div className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg border border-border bg-white py-2 pr-2 shadow-xs">
          <span className="grid w-11 shrink-0 place-items-center">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-navy text-white">
              <span className="font-serif text-[11px] font-bold tracking-[.04em]">TH</span>
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block truncate font-serif text-[14px] font-bold tracking-[.01em] text-navy">
              THINNR
            </strong>
            <span className="block truncate text-[10px] uppercase tracking-[.14em] text-muted-foreground">
              {brandSubtitle}
            </span>
          </span>
        </div>
      </div>

      {/* Ink action button */}
      {cta && CtaIcon && (
        <div className="px-3 pt-2.5">
          {cta.href && !onSelect ? (
            <Link
              href={cta.href}
              className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-md bg-[#101828] py-2 pr-2 text-left text-sm font-semibold text-white shadow-xs transition hover:bg-[#1d2a44] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid w-11 shrink-0 place-items-center">
                <CtaIcon size={16} strokeWidth={2.4} />
              </span>
              <span className="min-w-0 flex-1 truncate">{cta.label}</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={cta.onClick}
              className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-md bg-[#101828] py-2 pr-2 text-left text-sm font-semibold text-white shadow-xs transition hover:bg-[#1d2a44] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid w-11 shrink-0 place-items-center">
                <CtaIcon size={16} strokeWidth={2.4} />
              </span>
              <span className="min-w-0 flex-1 truncate">{cta.label}</span>
            </button>
          )}
        </div>
      )}

      {/* Sections, each opened by a hairline divider so the rail stays organized */}
      <nav aria-label="Primary">
        {sections.map((section) => (
          <div key={section.label} className="px-3">
            <div className="mt-4 border-t border-border/80" />
            <p className="mb-1.5 mt-3 whitespace-nowrap pl-[56px] text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground/90">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <MenuRow
                  key={item.path}
                  item={item}
                  active={isItemActive(item.path)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Foot: divider, account chip, then the pin control (+ optional gear) */}
      <div className="mt-auto px-3 pb-3 pt-4">
        <div className="border-t border-border/80 pt-3">
          <div className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg border border-border bg-white py-2 pr-2 shadow-xs">
            <span className="grid w-11 shrink-0 place-items-center">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-[#e8eef7] text-[10px] font-bold text-primary">
                {accountInitials}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <b className="block truncate text-xs font-semibold text-foreground">{accountName}</b>
              <small className="block truncate text-[10px] text-muted-foreground">{accountRole}</small>
            </span>
            {onSignOut && expanded && (
              <button
                type="button"
                aria-label="Sign out"
                onClick={onSignOut}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#5c6b81] transition hover:bg-[#f0f3f8] hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LogOut size={14} />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={onModeToggle}
              aria-label={mode === 'pinned' ? 'Switch to hover mode' : 'Switch to pinned mode'}
              title={
                mode === 'pinned'
                  ? 'Hover mode retracts the menu to a slim rail'
                  : 'Pinned mode keeps the menu open'
              }
              className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap rounded-md border border-border bg-white py-1.5 pr-2 text-left text-xs font-semibold text-[#43536b] shadow-xs transition hover:bg-[#f7f9fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid w-11 shrink-0 place-items-center">
                {mode === 'pinned' ? <Pin size={14} /> : <MousePointer2 size={14} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{mode === 'pinned' ? 'Pinned' : 'Hover'}</span>
            </button>
            {onSettings && expanded && (
              <button
                type="button"
                aria-label="Settings"
                onClick={onSettings}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-white text-[#5c6b81] shadow-xs transition hover:bg-[#f7f9fc] hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Settings2 size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function SideMenu(props: SideMenuProps) {
  const { mode, onModeChange, label = 'Sidebar' } = props;
  const [engaged, setEngaged] = useState(false);
  const expanded = mode === 'pinned' || engaged;

  // Flipping to hover keeps the menu open until the pointer leaves, so the
  // switch never yanks the menu out from under the cursor mid-click.
  const handleModeToggle = () => {
    const next: RailMode = mode === 'pinned' ? 'hover' : 'pinned';
    setEngaged(next === 'hover');
    onModeChange(next);
  };

  const content = <MenuColumn props={props} expanded={expanded} onModeToggle={handleModeToggle} />;

  if (mode === 'pinned') {
    return (
      <aside
        aria-label={label}
        className="hidden w-[264px] shrink-0 flex-col overflow-hidden border-r border-border bg-white text-foreground md:flex"
      >
        {content}
      </aside>
    );
  }

  return (
    <div className="relative hidden w-[68px] shrink-0 md:block">
      <aside
        aria-label={label}
        style={{ width: expanded ? MENU_EXPANDED_WIDTH : MENU_RAIL_WIDTH }}
        className={`absolute inset-y-0 left-0 z-30 flex flex-col overflow-hidden border-r border-border bg-white text-foreground transition-[width,box-shadow] duration-300 ease-out motion-reduce:transition-none ${
          expanded ? 'shadow-lifted' : ''
        }`}
        onPointerEnter={() => setEngaged(true)}
        onPointerLeave={() => setEngaged(false)}
        onFocusCapture={() => setEngaged(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setEngaged(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setEngaged(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }
        }}
      >
        {content}
      </aside>
    </div>
  );
}
