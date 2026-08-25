import { LogOut, Settings2 } from 'lucide-react';
import { isOfficeNavItemActive } from '@/components/layout/nav-config';
import { RailFrame } from './rail';
import type { MenuDesignProps } from './types';

/**
 * Option 1 — Pressed Linen.
 * Light without white: a warm pressed-linen ground where only the active room
 * gets a cream paper card. The calmest step away from today's menu.
 */
export function PressedLinen({
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
      designName="Pressed Linen"
      surfaceClassName="border-r border-[#ddd5c2] bg-[#efeadd] text-[#41506a]"
    >
      {/* Brand */}
      <div className="mx-3 mt-4 flex items-center gap-3 whitespace-nowrap pb-4">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-[#203b64] text-[#dce6fa] shadow-soft">
            <span className="text-[11px] font-bold tracking-[.04em]">TH</span>
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate font-serif text-[15px] font-bold tracking-[.01em] text-[#203b64]">
            THINNR
          </strong>
          <span className="block truncate text-[10px] uppercase tracking-[.14em] text-[#8a8267]">
            {workspaceLabel}
          </span>
        </span>
      </div>
      <div className="mx-4 border-b border-[#e0d8c5]" />

      <p className="mb-2 mt-5 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#98917b]">
        Workspace
      </p>
      <nav aria-label="Workspace" className="space-y-1">
        {items.map((item) => {
          const active = isOfficeNavItemActive(item.path, activePath);
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => onSelect(item.path)}
              aria-current={active ? 'page' : undefined}
              className={`mx-3 flex items-center gap-3 whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315eae] ${
                active
                  ? 'bg-[#fdfcf9] font-semibold text-[#203b64] shadow-soft'
                  : 'text-[#5d6a80] hover:bg-[#e6dfcd] hover:text-[#203b64]'
              }`}
            >
              <span className={`grid w-11 shrink-0 place-items-center ${active ? 'text-[#315eae]' : 'text-[#7a8398]'}`}>
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.path === '/patients' && (
                <span
                  className={`ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-bold text-[#315eae] ${
                    active ? 'bg-[#e3ecf7]' : 'bg-[#e5decb]'
                  }`}
                >
                  {patientCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <p className="mb-2 mt-7 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#98917b]">
        Manage
      </p>
      <button
        onClick={onSettings}
        className="mx-3 flex items-center gap-3 whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm text-[#5d6a80] transition hover:bg-[#e6dfcd] hover:text-[#203b64] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315eae]"
      >
        <span className="grid w-11 shrink-0 place-items-center text-[#7a8398]">
          <Settings2 size={16} />
        </span>
        <span className="min-w-0 flex-1">Settings</span>
      </button>

      {/* Account chip */}
      <div className="mx-3 mb-4 mt-auto flex items-center gap-3 whitespace-nowrap rounded-lg border border-[#e0d8c5] bg-[#f6f1e4] py-2.5 pr-2 shadow-soft">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-[#203b64] text-[10px] font-bold text-[#dce6fa]">
            {accountInitials}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-xs font-semibold text-[#203b64]">{accountName}</b>
          <small className="block truncate text-[10px] text-[#8a8267]">{accountRole}</small>
        </span>
        <button
          aria-label="Sign out"
          onClick={onSignOut}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#7a8398] transition hover:bg-[#ece5d3] hover:text-[#a04646] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315eae]"
        >
          <LogOut size={14} />
        </button>
      </div>
    </RailFrame>
  );
}
