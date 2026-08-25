import { LogOut, Settings2 } from 'lucide-react';
import { isOfficeNavItemActive } from '@/components/layout/nav-config';
import { RailFrame } from './rail';
import type { MenuDesignProps } from './types';

/**
 * Option 4 — Ink & Brass.
 * The darkest cut: near-black ink kept flat and quiet, with a single brass
 * thread (Heritage's warm accent, used tiny) marking the active room.
 */
export function InkBrass({
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
      designName="Ink & Brass"
      surfaceClassName="border-r border-[#1c2536] bg-[#0a111f] text-[#aab3c5]"
    >
      {/* Brand */}
      <div className="mx-3 mt-4 flex items-center gap-3 whitespace-nowrap pb-4">
        <span className="grid w-11 shrink-0 place-items-center">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-[#111a2c] text-[#f0e7d8] ring-1 ring-[#df772c]/50">
            <span className="text-[11px] font-bold tracking-[.04em]">TH</span>
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate font-serif text-[15px] font-bold tracking-[.01em] text-[#f0ede6]">
            THINNR
          </strong>
          <span className="block truncate text-[10px] uppercase tracking-[.14em] text-[#6f7a8e]">
            {workspaceLabel}
          </span>
        </span>
      </div>
      <div className="mx-4 border-b border-[#1c2536]" />

      <p className="mb-2 mt-5 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.2em] text-[#63708a]">
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
              className={`relative mx-3 flex items-center gap-3 whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#df9a5b] ${
                active
                  ? 'bg-white/[.04] font-semibold text-[#f4f1e9]'
                  : 'text-[#8b96ab] hover:bg-[#101a2d] hover:text-[#e8e4da]'
              }`}
            >
              {active && (
                <span aria-hidden className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-[#df772c]" />
              )}
              <span className={`grid w-11 shrink-0 place-items-center ${active ? 'text-[#df9a5b]' : 'text-[#6f80a3]'}`}>
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.path === '/patients' && (
                <span
                  className={`ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${
                    active ? 'bg-[#2a2417] text-[#e0a35c]' : 'bg-[#152039] text-[#8fa3c8]'
                  }`}
                >
                  {patientCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <p className="mb-2 mt-7 whitespace-nowrap pl-[68px] pr-3 text-[10px] font-bold uppercase tracking-[.2em] text-[#63708a]">
        Manage
      </p>
      <button
        onClick={onSettings}
        className="mx-3 flex items-center gap-3 whitespace-nowrap rounded-md py-2.5 pr-2 text-left text-sm text-[#8b96ab] transition hover:bg-[#101a2d] hover:text-[#e8e4da] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#df9a5b]"
      >
        <span className="grid w-11 shrink-0 place-items-center text-[#6f80a3]">
          <Settings2 size={16} />
        </span>
        <span className="min-w-0 flex-1">Settings</span>
      </button>

      {/* Account chip */}
      <div className="mt-auto border-t border-[#1c2536] pb-3 pt-3">
        <div className="mx-3 flex items-center gap-3 whitespace-nowrap py-1 pr-2">
          <span className="grid w-11 shrink-0 place-items-center">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-[#131d31] text-[10px] font-bold text-[#f0e7d8] ring-1 ring-[#df772c]/40">
              {accountInitials}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-xs font-semibold text-[#ece8de]">{accountName}</b>
            <small className="block truncate text-[10px] text-[#6f7a8e]">{accountRole}</small>
          </span>
          <button
            aria-label="Sign out"
            onClick={onSignOut}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#8b96ab] transition hover:bg-[#101a2d] hover:text-[#f0ede6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#df9a5b]"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </RailFrame>
  );
}
