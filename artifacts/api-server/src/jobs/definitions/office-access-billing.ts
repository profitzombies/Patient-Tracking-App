/**
 * Renewals and dunning for the offices' own THINNR access subscriptions.
 *
 * Production runs no in-process timers, so the recovery schedule only advances
 * when this job ticks. It is idempotent: the per-period claim makes a repeated
 * run a no-op rather than a second charge.
 */
import { runOfficeAccessBilling } from "../../billing/office-access/dunning";
import { forEachBillingScope } from "../../billing/lifecycle-scopes";
import type { JobDefinition } from "../types";

const HOUR_MS = 60 * 60 * 1000;

export const officeAccessBillingJob: JobDefinition = {
  name: "office-access-billing",
  title: "Office access billing",
  description: "Charges offices for THINNR access, runs the recovery schedule, and restricts offices that never pay.",
  intervalMs: 6 * HOUR_MS,
  leaseSeconds: 15 * 60,
  run: (ctx) => forEachBillingScope(() => runOfficeAccessBilling(ctx)),
};
