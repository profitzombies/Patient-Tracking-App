/**
 * Express middleware: binds the dependency flags to the request, and on
 * finish logs one line per response with a stable route label, status,
 * duration, and whether the database or an AI model was used, then records
 * the duration in the process histogram. Requests slower than their family's
 * amber budget log at warn level so a slow route stands out in the log
 * stream before anyone opens System health.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { runWithRequestFlags, type RequestDependencyFlags } from "./request-context";
import {
  RequestMetricsRecorder,
  createMetricsFlusher,
  isSlowRequest,
  routeFamily,
  routeLabel,
  type MetricsFlusher,
} from "./request-metrics";

export const METRICS_INSTANCE = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface RequestTimingOptions {
  recorder?: RequestMetricsRecorder;
  flusher?: MetricsFlusher | null;
  now?: () => number;
}

export interface RequestTiming {
  middleware: RequestHandler;
  recorder: RequestMetricsRecorder;
  flusher: MetricsFlusher | null;
}

export function createRequestTiming(options: RequestTimingOptions = {}): RequestTiming {
  const recorder = options.recorder ?? new RequestMetricsRecorder(METRICS_INSTANCE);
  const flusher = options.flusher === undefined ? createMetricsFlusher(recorder) : options.flusher;
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const flags: RequestDependencyFlags = { db: false, ai: false };
    const started = process.hrtime.bigint();
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const route = routeLabel(req);
      const family = routeFamily(route);
      const status = res.statusCode;
      const slow = isSlowRequest(family, durationMs);
      const line = {
        req: { id: req.id, method: req.method, url: req.originalUrl.split("?")[0] },
        route,
        family,
        status,
        durationMs: Math.round(durationMs * 10) / 10,
        db: flags.db,
        ai: flags.ai,
        ...(aborted ? { aborted: true } : {}),
        ...(slow ? { slow: true } : {}),
      };
      const log = (req.log as typeof logger | undefined) ?? logger;
      if (slow) log.warn(line, "slow request");
      else log.info(line, "request completed");
      recorder.record({ family, status, durationMs, flags, at: options.now?.() });
      flusher?.poke();
    };
    res.on("finish", () => finish(false));
    res.on("close", () => finish(!res.writableFinished));
    runWithRequestFlags(flags, () => next());
  };
  return { middleware, recorder, flusher };
}
