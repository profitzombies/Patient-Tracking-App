/**
 * One-time back-fill: name every office's access customer in THINNR's Stripe
 * dashboard, set its default card, put holder names on saved methods and
 * detach replaced ones. Walks every payment mode this deployment holds
 * credentials for (Test and Live).
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-office-access-identity.ts            # dry run
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-office-access-identity.ts --apply    # write
 *   ... --mode=test | --mode=live                                                                     # one mode only
 *
 * The dry run writes nothing, to Stripe or to THINNR's rows.
 */
import { runWithBillingIdentity } from "../src/billing/stripe-environment";
import { configuredModes } from "../src/billing/office-access/customer-identity";
import { backfillAccessIdentity } from "../src/billing/office-access/identity-backfill";

const apply = process.argv.includes("--apply");
const only = process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
if (only && only !== "test" && only !== "live") throw new Error("--mode must be test or live.");

let failed = 0;
const modes = configuredModes().filter((identity) => !only || identity.mode === only);
if (!modes.length) throw new Error("No Stripe platform account is configured for the requested mode.");
console.log(`${apply ? "APPLY" : "DRY RUN"} — modes: ${modes.map((m) => m.mode).join(", ")}`);
for (const identity of modes) {
  const report = await runWithBillingIdentity(identity, () => backfillAccessIdentity({ apply }));
  console.log(`\n[${report.mode}] ${report.offices.length} office customer(s)`);
  for (const office of report.offices) {
    const parts = [
      office.customerChanges.length ? `customer: ${office.customerChanges.join(", ")}` : "customer up to date",
      office.methodNamesFilled ? `${office.methodNamesFilled} method name(s)` : null,
      office.replacedDetached ? `${office.replacedDetached} replaced method(s) detached` : null,
      office.replacedDeferred ? `${office.replacedDeferred} detach(es) deferred (charge in flight)` : null,
      office.untrackedDetached.length ? `untracked detached: ${office.untrackedDetached.join(", ")}` : null,
    ].filter(Boolean);
    console.log(`  ${office.error ? "FAIL" : "ok  "} ${office.providerId} ${office.customerId} — ${office.error ?? parts.join("; ")}`);
    if (office.error) failed += 1;
  }
}
if (!apply) console.log("\nDry run only. Re-run with --apply to write these changes.");
if (failed) { console.error(`\n${failed} office(s) failed.`); process.exit(1); }
