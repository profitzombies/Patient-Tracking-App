import { type ReactNode, useState } from 'react';
import type { RailMode } from './types';

/** Slim rail width shared by every design — icons center on x = 34px. */
export const RAIL_WIDTH = 68;
/** Default expanded menu width (designs may widen it). */
export const MENU_WIDTH = 264;

interface RailFrameProps {
  mode: RailMode;
  designName: string;
  /** Surface classes for the menu panel (background, right border, text). */
  surfaceClassName: string;
  expandedWidth?: number;
  children: ReactNode;
}

/**
 * Shared pinned/hover mechanics for every lab design.
 *
 * Pinned renders the menu in-flow at full width. Hover keeps a slim rail
 * in-flow (so the page never reflows) and expands the full menu as an overlay
 * on pointer hover or keyboard focus. Content is laid out at full width
 * inside a clipping window, so the reveal is a smooth wipe — icons never
 * shift, labels slide out from under the clip edge. Escape collapses.
 */
export function RailFrame({
  mode,
  designName,
  surfaceClassName,
  expandedWidth = MENU_WIDTH,
  children,
}: RailFrameProps) {
  const [engaged, setEngaged] = useState(false);
  const expanded = mode === 'pinned' || engaged;

  // Heights come from flex stretch, never `h-full`: the stage sits in a
  // min-h-full column whose height is indefinite, so percentage heights
  // collapse to content height (and to zero for the hover wrapper).
  const content = (
    <div style={{ width: expandedWidth }} className="relative flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );

  if (mode === 'pinned') {
    return (
      <aside
        aria-label={`${designName} menu preview`}
        style={{ width: expandedWidth }}
        className={`flex shrink-0 flex-col overflow-hidden ${surfaceClassName}`}
      >
        {content}
      </aside>
    );
  }

  return (
    <div style={{ width: RAIL_WIDTH }} className="relative shrink-0">
      <aside
        aria-label={`${designName} menu preview`}
        style={{ width: expanded ? expandedWidth : RAIL_WIDTH }}
        className={`absolute inset-y-0 left-0 z-30 flex flex-col overflow-hidden transition-[width,box-shadow] duration-300 ease-out motion-reduce:transition-none ${
          expanded ? 'shadow-lifted' : ''
        } ${surfaceClassName}`}
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
