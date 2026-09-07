import app from "./app";
import { logger } from "./lib/logger";
import { startExportWorker } from "./exports/worker";
import { startNotificationWorker } from "./notifications/worker";
import { startPrivacyWorker } from "./privacy/worker";
import { registerAllJobs } from "./jobs";
import { startJobScheduler } from "./jobs/scheduler";

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
});
