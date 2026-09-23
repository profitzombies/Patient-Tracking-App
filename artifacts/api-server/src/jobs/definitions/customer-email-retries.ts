import { forEachBillingScope } from "../../billing/lifecycle-scopes";
import { drainDueRetries } from "../../billing/customer-email-ledger";
import { forEachSandboxVerificationScope } from "../../billing/sandbox-verification";
import type { JobDefinition } from "../types";

/**
 * customer-email-retries: every minute, deliver customer emails whose retry
 * is due (a vendor failure schedules the next attempt with a short backoff;
 * three attempts per row, then the row is terminal). Re-composes from the
 * stored template id + variables, so no order or subscription is re-read.
 * Live scope, plus explicitly flagged sandbox-verification orders in the test
 * scope (the only test-mode rows that can ever claim).
 * Production runs no process timers: this job is reachable from the external
 * tick like every other worker family, and dry runs count without sending.
 */
const MINUTE_MS = 60_000;

export const customerEmailRetriesJob: JobDefinition = {
  name: "customer-email-retries",
  title: "Customer email retries",
  description: "Re-sends order and shipment emails that the email vendor rejected, up to three attempts each.",
  intervalMs: 1 * MINUTE_MS,
  leaseSeconds: 5 * 60,
  run: async (ctx) => {
    await forEachBillingScope(() => drainDueRetries(ctx), ["live"]);
    await forEachSandboxVerificationScope((onlyOrderIds) => drainDueRetries(ctx, { onlyOrderIds }), ctx.now);
  },
};
