import React from 'react';
import { Modal, type ModalProps } from 'react-native';
import { WebFitShell } from '@/components/WebFitShell';

/**
 * Drop-in replacement for react-native's Modal — app code must always use
 * this instead of importing Modal from react-native (permanent web-parity
 * rule, see replit.md).
 *
 * Why: react-native-web implements Modal by portalling its content to a new
 * child of document.body with position:fixed — OUTSIDE the WebFitShell
 * canvas. A plain Modal on web therefore lays out against the real,
 * unscaled browser viewport and breaks the iPhone-size parity every other
 * surface follows. AppModal keeps RNW's Modal (its portal, focus trap,
 * Escape handling, and enter/exit animations all still apply) and simply
 * re-applies the fit-to-reference canvas INSIDE it, so modal content lays
 * out at the same fixed iPhone width and visual scale as the rest of the
 * app — including under a ?layoutWidth= override, which both shells read
 * from the same startup-resolved mode.
 *
 * Native platforms (and non-DOM environments / ?layoutWidth=off, where
 * WebFitShell renders children untouched) behave exactly like the plain
 * Modal — byte-identical trees.
 */
export function AppModal({ children, ...rest }: ModalProps) {
  return (
    <Modal {...rest}>
      <WebFitShell
        testID="web-fit-modal-canvas"
        viewportTestID="web-fit-modal-viewport"
      >
        {children}
      </WebFitShell>
    </Modal>
  );
}
