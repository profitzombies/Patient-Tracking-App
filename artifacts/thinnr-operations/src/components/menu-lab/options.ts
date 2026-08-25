import type { ComponentType } from 'react';
import type { MenuDesignProps } from './types';
import { PressedLinen } from './PressedLinen';
import { CobaltStandard } from './CobaltStandard';
import { MidnightLedger } from './MidnightLedger';
import { InkBrass } from './InkBrass';
import { GalleryRail } from './GalleryRail';

export interface MenuDesignOption {
  id: string;
  name: string;
  /** One-line rationale shown with the picker. */
  blurb: string;
  Component: ComponentType<MenuDesignProps>;
}

/** The five candidate directions, lightest to darkest, structural last. */
export const MENU_DESIGN_OPTIONS: MenuDesignOption[] = [
  {
    id: 'pressed-linen',
    name: 'Pressed Linen',
    blurb:
      'Warm linen ground with a cream paper card for the active room — less white without going dark.',
    Component: PressedLinen,
  },
  {
    id: 'cobalt-standard',
    name: 'Cobalt Standard',
    blurb:
      "The brand's cobalt as a full bleed — cream paper is reserved for the room you're in.",
    Component: CobaltStandard,
  },
  {
    id: 'midnight-ledger',
    name: 'Midnight Ledger',
    blurb:
      'Deep navy nightfall — a properly dark rail that makes the cream workspace glow.',
    Component: MidnightLedger,
  },
  {
    id: 'ink-brass',
    name: 'Ink & Brass',
    blurb:
      'The darkest cut — near-black ink with a single brass thread marking where you are.',
    Component: InkBrass,
  },
  {
    id: 'gallery-rail',
    name: 'Gallery Rail',
    blurb:
      'A navy spine carries the icons, labels sit on a tinted wing — two tones, zero white panels.',
    Component: GalleryRail,
  },
];
