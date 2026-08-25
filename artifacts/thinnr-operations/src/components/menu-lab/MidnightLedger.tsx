import { LogOut, Settings2 } from 'lucide-react';
import { isOfficeNavItemActive } from '@/components/layout/nav-config';
import { RailFrame } from './rail';
import type { MenuDesignProps } from './types';

/**
 * Option 3 — Midnight Ledger.
 * A properly dark rail: deep navy nightfall with a lifted card and cobalt
 * glow marking the active room, so the cream workspace beside it shines.
 */
export function MidnightLedger({
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
      designName="Midnight Ledger"
      surfaceClassName="border-r border-[#22314f] bg-[linear-gradient(180deg,#13233c_0%,#0d1930_100%)] text-[#c6d0e2]"
    >
      {/* Brand */}
      <div className="mx-3 mt-4 flex items-center gap-3 whitespace-nowrap pb-4">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-[#315eae] text-[#e8effc] shadow-lifted">
            <span className="text-[11px] font-bold tracking-[.04em]">TH</span>
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate font-serif text-[15px] font-bold tracking-[.01em] text-[#ecf0f7]">
            THINNR
          </strong>
          <span className="block truncate text-[10px] uppercase tracking-[.14em] text-[#75849f]">
            {workspaceLabel}
          </span>
        </span>
      </div>
      <div className="mx-4 border-b border-[#22314f]" />

      <p className="mb-2 mt-5 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#5e6d89]">
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
              className={`mx-3 flex items-center gap-3 whitespace-nowrap rounded-md border-l-2 py-2.5 pr-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7397d8] ${
                active
                  ? 'border-l-[#7397d8] bg-[#1b2d4d] font-semibold text-[#f0f4fa] shadow-[0_10px_24px_-14px_rgba(49,94,174,.7)]'
                  : 'border-l-transparent text-[#93a1b8] hover:bg-[#16294a] hover:text-[#e2e8f2]'
              }`}
            >
              <span className={`grid w-11 shrink-0 place-items-center ${active ? 'text-[#8fb0e8]' : 'text-[#7d90b4]'}`}>
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.path === '/patients' && (
                <span
                  className={`ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${
                    active ? 'bg-[#254069] text-[#aac4ee]' : 'bg-[#1a2b4c] text-[#8fa6cd]'
                  }`}
                >
                  {patientCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <p className="mb-2 mt-7 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#5e6d89]">
        Manage
      </p>
      <button
        onClick={onSettings}
        className="mx-3 flex items-center gap-3 whitespace-nowrap rounded-md border-l-2 border-l-transparent py-2.5 pr-2 text-left text-sm text-[#93a1b8] transition hover:bg-[#16294a] hover:text-[#e2e8f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7397d8]"
      >
        <span className="grid w-11 shrink-0 place-items-center text-[#7d90b4]">
          <Settings2 size={16} />
        </span>
        <span className="min-w-0 flex-1">Settings</span>
      </button>

      {/* Account chip */}
      <div className="mx-3 mb-4 mt-auto flex items-center gap-3 whitespace-nowrap rounded-lg border border-[#243553] bg-[#13233c] py-2.5 pr-2">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-[#24406e] text-[10px] font-bold text-[#cfdcf3]">
            {accountInitials}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-xs font-semibold text-[#e9edf3]">{accountName}</b>
          <small className="block truncate text-[10px] text-[#75849f]">{accountRole}</small>
        </span>
        <button
          aria-label="Sign out"
          onClick={onSignOut}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#93a1b8] transition hover:bg-[#1b2d4d] hover:text-[#e2e8f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7397d8]"
        >
          <LogOut size={14} />
        </button>
      </div>
    </RailFrame>
  );
}
