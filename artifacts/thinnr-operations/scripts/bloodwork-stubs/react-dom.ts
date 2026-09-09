import type { ReactNode } from 'react';

/** DOM-free portal stand-in used only by verify-bloodwork-ui.tsx. */
export function createPortal(children: ReactNode, _container?: unknown): ReactNode {
  return children;
}