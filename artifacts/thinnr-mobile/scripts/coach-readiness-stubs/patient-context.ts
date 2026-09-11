/** Minimal CoachChatContext seam for the Node readiness harness. */
import type { NudgeAssessment } from '../../data/stall-nudge';

export function usePatient() {
  return {
    nudgeAssessment: null as unknown as NudgeAssessment,
    shouldSeedNudgeOutreach: false,
    recordNudgeSent: async () => {},
    markNudgeEngaged: () => {},
    setNudgeOptOut: () => {},
  };
}