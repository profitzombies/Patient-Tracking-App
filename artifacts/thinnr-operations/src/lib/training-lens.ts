import type { TrainingViewer } from '@/data/hq/training';

/**
 * Which learners the office training pages may consider at all.
 *
 * The unscoped lens (`accountId === null`, every office-assigned learner) is
 * the demo persona's view of the seeded network. A signed-in account must
 * never land on it: without an office on the sign-in, only the staffer's own
 * row remains. The membership rule itself (isOfficeTeammate) is shared with
 * the mobile app, so it stays untouched; this narrows its input instead.
 */
export function officeLensViewers(
  viewers: TrainingViewer[],
  { signedIn, accountId, selfViewerId }: { signedIn: boolean; accountId: string | null; selfViewerId: string | null },
): TrainingViewer[] {
  if (!signedIn || accountId !== null) return viewers;
  return selfViewerId === null ? [] : viewers.filter((viewer) => viewer.id === selfViewerId);
}
