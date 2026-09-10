/**
 * Extensible card slot for assistant messages.
 *
 * Later features (recipe cards, product suggestions) register a renderer for
 * their card kind here; the chat thread stays unchanged. Unknown kinds render
 * nothing, so older clients degrade gracefully.
 */
import React from 'react';
import type { CoachCard } from '@/context/CoachChatContext';

type CoachCardRenderer = (props: {
  payload: unknown;
  /**
   * Id of the chat message this card rides on. Cards that act in place
   * (e.g. the label flow's food card) use it to address their message in
   * the chat context; display-only cards ignore it.
   */
  messageId: string;
  /** Archived Coach conversations render cards without actionable controls. */
  readOnly?: boolean;
}) => React.ReactElement | null;

const CARD_RENDERERS: Record<string, CoachCardRenderer> = {};

export function registerCoachCard(kind: string, renderer: CoachCardRenderer): void {
  CARD_RENDERERS[kind] = renderer;
}

export function CoachCardSlot({
  card,
  messageId,
  readOnly = false,
}: {
  card: CoachCard;
  messageId: string;
  readOnly?: boolean;
}) {
  const Renderer = CARD_RENDERERS[card.kind];
  if (!Renderer) return null;
  return <Renderer payload={card.payload} messageId={messageId} readOnly={readOnly} />;
}
