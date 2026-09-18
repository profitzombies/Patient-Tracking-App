import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { COACH_CHAT_PATH } from "./routes/coach";
import { MENU_SCAN_PATH } from "./routes/menu-scan";
import { LABEL_SCAN_PATH } from "./routes/label-scan";
import billingWebhooksRouter from "./routes/billing-webhooks";
import { logger } from "./lib/logger";
import { createRequestTiming } from "./lib/request-timing";
import { markRequestDependency } from "./lib/request-context";
import * as openaiServer from "@workspace/integrations-openai-ai-server";

const app: Express = express();

// All traffic arrives through the Replit proxy; trust X-Forwarded-For so
// req.ip reflects the real client (used by the coach rate limiter).
app.set("trust proxy", true);

// pino-http supplies req.id and req.log; the completion line itself comes
// from the request-timing middleware below so every response carries a
// stable route label, its duration, and the db/ai flags.
app.use(
  pinoHttp({
    logger,
    autoLogging: false,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
export const requestTiming = createRequestTiming();
app.use(requestTiming.middleware);
// Every model call through the shared OpenAI client flags the request as
// AI-backed. Route suites replace the client module with a partial mock, so
// the hook is looked up rather than imported by name.
if ("observeOpenAIRequests" in openaiServer) {
  openaiServer.observeOpenAIRequests(() => markRequestDependency("ai"));
}
/**
 * Browser origins are restricted to this app's own surfaces: localhost dev
 * and Replit-hosted domains (the Expo web build is served from a different
 * Replit origin than the API, so a plain same-origin policy is not enough).
 * Requests without an Origin header (native app, curl) pass through — CORS
 * only governs browsers; abuse is bounded by the coach rate limiter.
 */
const ALLOWED_ORIGIN_SUFFIXES = [".replit.dev", ".replit.app", ".repl.co"];

function isAllowedOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || isAllowedOrigin(origin));
    },
  }),
);
// The photo-carrying routes (menu scan, coach chat with an attached menu
// photo) accept a photo-sized JSON body and mount their own parsers with a
// larger limit; every other route keeps the default 100kb guard.
// Stripe webhooks verify a signature over the exact raw bytes, so they mount
// ahead of every body parser (the router applies express.raw itself).
app.use("/api/billing/webhooks", billingWebhooksRouter);

const LARGE_BODY_PATHS = new Set([MENU_SCAN_PATH, LABEL_SCAN_PATH, COACH_CHAT_PATH]);
const jsonParser = express.json();
app.use((req, res, next) => {
  if (LARGE_BODY_PATHS.has(req.path)) {
    next();
    return;
  }
  jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
