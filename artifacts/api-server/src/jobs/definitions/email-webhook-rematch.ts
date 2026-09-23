import { rematchUnmatchedEvents } from "../../email/vendor-webhook";
import type { JobDefinition } from "../types";

/**
 * email-webhook-rematch: every minute, re-try vendor delivery events whose
 * message id had no customer email ledger row when they arrived (the
 * vendor's own "sent" event can beat our ledger update), and drop unmatched
 * events past retention. Reachable from the external tick like every other
 * worker family; dry runs count matches without writing.
 */
const MINUTE_MS = 60_000;

export const emailWebhookRematchJob: JobDefinition = {
  name: "email-webhook-rematch",
  title: "Email delivery event matching",
  description: "Attaches email vendor delivery events that arrived before their ledger row to the customer email they belong to; prunes unmatched events past retention.",
  intervalMs: 1 * MINUTE_MS,
  leaseSeconds: 5 * 60,
  run: async (ctx) => {
    const counts = await rematchUnmatchedEvents({ now: ctx.now, dryRun: ctx.dryRun });
    ctx.tally("scanned", counts.scanned);
    ctx.tally("matched", counts.matched);
    ctx.tally("pruned", counts.pruned);
  },
};
