import { LogOut, Settings2 } from 'lucide-react';
import { isOfficeNavItemActive } from '@/components/layout/nav-config';
import { RailFrame } from './rail';
import type { MenuDesignProps } from './types';

/**
 * Option 5 — Gallery Rail.
 * Two-tone structure: a navy gallery spine carries the icons, labels live on
 * a tinted cobalt wing — contrast comes from architecture, not white panels.
 * In hover mode only the navy spine remains.
 */
export function GalleryRail({
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
}: MenuDesignProps) {
  return (
    <RailFrame
      mode={mode}
      designName="Gallery Rail"
      expandedWidth={292}
      surfaceClassName="border-r border-[#c6d4ea] bg-[#e3ecf7] text-[#2c3c58]"
    >
      {/* Navy spine behind the icon column */}
      <div aria-hidden className="absolute inset-y-0 left-0 w-[68px] border-r border-[#2c4a7c] bg-[#203b64]" />

      <div className="relative z-10 flex h-full min-h-0 flex-col">
        {/* Brand */}
        <div className="flex items-center whitespace-nowrap pb-3 pt-4">
          <span className="grid w-[68px] shrink-0 place-items-center">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-[#dce6fa] text-[#203b64] shadow-lifted">
              <span className="text-[11px] font-bold tracking-[.04em]">TH</span>
            </span>
          </span>
          <span className="min-w-0 flex-1 pl-3 pr-3">
            <strong className="block truncate font-serif text-[15px] font-bold tracking-[.01em] text-[#203b64]">
              THINNR
            </strong>
            <span className="block truncate text-[10px] uppercase tracking-[.14em] text-[#5b6c8c]">
              {workspaceLabel}
            </span>
          </span>
        </div>

        <p className="mb-2 mt-3 whitespace-nowrap pl-[80px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#7287ab]">
          Workspace
        </p>
        <nav aria-label="Workspace" className="space-y-0.5">
          {items.map((item) => {
            const active = isOfficeNavItemActive(item.path, activePath);
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                onClick={() => onSelect(item.path)}
                aria-current={active ? 'page' : undefined}
                className="group flex w-full items-center whitespace-nowrap py-0.5 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6f95d6]"
              >
                <span className="grid w-[68px] shrink-0 place-items-center py-1">
                  <span
                    className={`grid h-9 w-9 place-items-center rounded-md transition ${
                      active
                        ? 'bg-[#315eae] text-white shadow-lifted'
                        : 'text-[#93a9d3] group-hover:bg-[#2b4a7d] group-hover:text-[#dce6fa]'
                    }`}
                  >
                    <Icon size={16} />
                  </span>
                </span>
                <span
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                    active
                      ? 'bg-[#d5e1f3] font-semibold text-[#203b64]'
                      : 'text-[#4d6183] group-hover:bg-[#d9e4f4] group-hover:text-[#203b64]'
                  }`}
                >
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.path === '/patients' && (
                    <span
                      className={`ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-bold text-[#315eae] ${
                        active ? 'bg-[#fdfcf9]/80' : 'bg-[#cfdcf0]'
                      }`}
                    >
                      {patientCount}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        <p className="mb-2 mt-6 whitespace-nowrap pl-[80px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#7287ab]">
          Manage
        </p>
        <button
          onClick={onSettings}
          className="group flex w-full items-center whitespace-nowrap py-0.5 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6f95d6]"
        >
          <span className="grid w-[68px] shrink-0 place-items-center py-1">
            <span className="grid h-9 w-9 place-items-center rounded-md text-[#93a9d3] transition group-hover:bg-[#2b4a7d] group-hover:text-[#dce6fa]">
              <Settings2 size={16} />
            </span>
          </span>
          <span className="flex min-w-0 flex-1 items-center rounded-md px-3 py-2 text-sm text-[#4d6183] transition group-hover:bg-[#d9e4f4] group-hover:text-[#203b64]">
            Settings
          </span>
        </button>

        {/* Account chip */}
        <div className="mt-auto flex items-center whitespace-nowrap pb-3 pt-2">
          <span className="grid w-[68px] shrink-0 place-items-center">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-[#dce6fa] text-[10px] font-bold text-[#203b64]">
              {accountInitials}
            </span>
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2 border-t border-[#c9d6ec] py-2 pl-3 pr-3">
            <span className="min-w-0 flex-1">
              <b className="block truncate text-xs font-semibold text-[#203b64]">{accountName}</b>
              <small className="block truncate text-[10px] text-[#5b6c8c]">{accountRole}</small>
            </span>
            <button
              aria-label="Sign out"
              onClick={onSignOut}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#5b6c8c] transition hover:bg-[#d0ddf0] hover:text-[#203b64] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6f95d6]"
            >
              <LogOut size={14} />
            </button>
          </span>
        </div>
      </div>
    </RailFrame>
  );
}
