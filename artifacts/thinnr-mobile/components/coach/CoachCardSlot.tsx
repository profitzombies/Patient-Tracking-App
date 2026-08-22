/**
 * Extensible card slot for assistant messages.
 *
 * Later features (recipe cards, product suggestions) register a renderer for
 * their card kind here; the chat thread stays unchanged. Unknown kinds render
 * nothing, so older clients degrade gracefully.
 */
import React from 'react';
import type { CoachCard } from '@/context/CoachChatContext';

type CoachCardRenderer = (props: { payload: unknown }) => React.ReactElement | null;

const CARD_RENDERERS: Record<string, CoachCardRenderer> = {};

export function registerCoachCard(kind: string, renderer: CoachCardRenderer): void {
  CARD_RENDERERS[kind] = renderer;
}

export function CoachCardSlot({ card }: { card: CoachCard }) {
  const Renderer = CARD_RENDERERS[card.kind];
  if (!Renderer) return null;
  return <Renderer payload={card.payload} />;
}
