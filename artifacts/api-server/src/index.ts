import app, { requestTiming } from "./app";
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
  // In-process background timers. Production runs as an autoscale deployment
  // where no process is guaranteed to be alive, so it sets JOBS_DISABLED=1 and
  // NOTIFICATIONS_DISABLED=1 and an external scheduled trigger POSTs
  // /api/internal/jobs/tick and /api/internal/notifications/tick every minute
  // (see replit.md → Production background work). Development keeps the timers.
  //
  // CSV export jobs (off under JOBS_DISABLED; the job tick drains them).
  startExportWorker();
  // Push outbox + coach outreach evaluation (off under NOTIFICATIONS_DISABLED).
  startNotificationWorker();
  // Patient data exports + due account purges (off under JOBS_DISABLED; the job tick drains them).
  startPrivacyWorker();
  // Scheduled clean-up: abandoned uploads, storage reconciliation, retention
  // (off under JOBS_DISABLED; POST /internal/jobs/tick runs due jobs).
  registerAllJobs();
  startJobScheduler();
  void ensureBillingWebhookEndpoints();
});

// Land the in-memory latency histogram (including the open minute) before a
// restart or scale-down takes the process away; capped so a slow database
// cannot hold the shutdown.
const FINAL_FLUSH_CAP_MS = 3_000;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    const cap = new Promise<void>((resolve) => setTimeout(resolve, FINAL_FLUSH_CAP_MS).unref());
    Promise.race([requestTiming.flusher?.flush(true) ?? Promise.resolve(), cap])
      .catch((error: unknown) => logger.warn({ err: error }, "final request metrics flush failed"))
      .finally(() => process.exit(0));
  });
}
