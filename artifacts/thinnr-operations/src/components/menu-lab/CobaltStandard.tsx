import { LogOut, Settings2 } from 'lucide-react';
import { isOfficeNavItemActive } from '@/components/layout/nav-config';
import { RailFrame } from './rail';
import type { MenuDesignProps } from './types';

/**
 * Option 2 — Cobalt Standard.
 * The brand's cobalt as a full-bleed banner: the menu becomes THINNR's
 * signature stripe, and cream paper is reserved for the room you're in.
 */
export function CobaltStandard({
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
      designName="Cobalt Standard"
      surfaceClassName="border-r border-[#24457f] bg-[linear-gradient(180deg,#3563b2_0%,#2a4f93_55%,#213e75_100%)] text-[#dbe5f6]"
    >
      {/* Brand */}
      <div className="mx-3 mt-4 flex items-center gap-3 whitespace-nowrap pb-4">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-[#fdfcf9] text-[#203b64] shadow-lifted">
            <span className="text-[11px] font-bold tracking-[.04em]">TH</span>
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate font-serif text-[15px] font-bold tracking-[.01em] text-[#f5f8fd]">
            THINNR
          </strong>
          <span className="block truncate text-[10px] uppercase tracking-[.14em] text-[#a9bfe6]">
            {workspaceLabel}
          </span>
        </span>
      </div>
      <div className="mx-4 border-b border-white/15" />

      <p className="mb-2 mt-5 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#8fabdd]">
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
              className={`mx-3 flex items-center gap-3 whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cfdcf3] ${
                active
                  ? 'bg-[#fdfcf9] font-semibold text-[#203b64] shadow-lifted'
                  : 'text-[#c6d4ef] hover:bg-white/10 hover:text-white'
              }`}
            >
              <span className={`grid w-11 shrink-0 place-items-center ${active ? 'text-[#315eae]' : 'text-[#a9bfe6]'}`}>
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.path === '/patients' && (
                <span
                  className={`ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${
                    active ? 'bg-[#e3ecf7] text-[#315eae]' : 'bg-white/15 text-[#e6edf9]'
                  }`}
                >
                  {patientCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <p className="mb-2 mt-7 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#8fabdd]">
        Manage
      </p>
      <button
        onClick={onSettings}
        className="mx-3 flex items-center gap-3 whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm text-[#c6d4ef] transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cfdcf3]"
      >
        <span className="grid w-11 shrink-0 place-items-center text-[#a9bfe6]">
          <Settings2 size={16} />
        </span>
        <span className="min-w-0 flex-1">Settings</span>
      </button>

      {/* Account chip */}
      <div className="mx-3 mb-4 mt-auto flex items-center gap-3 whitespace-nowrap rounded-lg border border-white/15 bg-white/10 py-2.5 pr-2">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-[#fdfcf9] text-[10px] font-bold text-[#203b64]">
            {accountInitials}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-xs font-semibold text-[#f5f8fd]">{accountName}</b>
          <small className="block truncate text-[10px] text-[#a9bfe6]">{accountRole}</small>
        </span>
        <button
          aria-label="Sign out"
          onClick={onSignOut}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#c6d4ef] transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cfdcf3]"
        >
          <LogOut size={14} />
        </button>
      </div>
    </RailFrame>
  );
}
