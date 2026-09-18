import app from "./app";
import { logger } from "./lib/logger";
import { startExportWorker } from "./exports/worker";
import { startNotificationWorker } from "./notifications/worker";
import { startPrivacyWorker } from "./privacy/worker";
import { registerAllJobs } from "./jobs";
import { startJobScheduler } from "./jobs/scheduler";
import { ensureBillingWebhookEndpoints } from "./billing/webhook-endpoints";
import { usageStore } from "./coach/usage-store";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // Coach usage caps are reserved in Supabase so they hold across every
  // server copy; the memory twin only guards a single process, so running
  // on it is called out loudly rather than discovered from an AI bill.
  const limits = usageStore();
  if (limits.mode === "database") {
    logger.info({ store: limits.mode }, "coach usage limits store");
  } else {
    logger.warn({ store: limits.mode }, "coach usage limits are process-local: caps will not hold across server copies or restarts");
  }
  // CSV export jobs are generated in-process; the worker is idle otherwise.
  startExportWorker();
  // Push outbox + coach outreach evaluation; NOTIFICATIONS_DISABLED=1 leaves it
  // to the external scheduler trigger.
  startNotificationWorker();
  // Patient data exports + due account purges.
  startPrivacyWorker();
  // Scheduled clean-up: abandoned uploads, storage reconciliation, retention.
  // JOBS_DISABLED=1 leaves it to the internal trigger (POST /internal/jobs/tick).
  registerAllJobs();
  startJobScheduler();
  void ensureBillingWebhookEndpoints();
});
