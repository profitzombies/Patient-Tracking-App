/**
 * What every route that mints a session does right before handing the
 * token hash back: record the sign-in, decide whether it is a new device,
 * and raise the alert. Also the forced-reset gate and the recovery-completion
 * sweep. Kept apart from auth.ts so the verify handlers stay readable.
 *
 * The ledger write is fail-closed for the sign-in: if the row cannot be
 * recorded, the route reports a server error and the caller retries — a
 * sign-in that never shows up in "recent sign-ins" would defeat the point.
 */
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { logger } from "../lib/logger";
import { describeAccount } from "./actor";
import { raiseNewDeviceAlert } from "./alerts";
import {
  adminLogoutAll,
  loadSecurityState,
  markRevoked,
  recordSignIn,
  setForcedReset,
  type Realm,
  type SignInMethod,
} from "./ledger";

export const PASSWORD_RESET_REQUIRED_CODE = "PASSWORD_RESET_REQUIRED";
export const PASSWORD_RESET_REQUIRED_MESSAGE =
  "For your security, choose a new password before signing in. Use \"Forgot password\" to continue.";

interface RequestLike {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
  log?: { error: (obj: unknown, msg?: string) => void };
}

/** Express already honours trust proxy for req.ip; fall back to the socket. */
function ipOf(req: RequestLike): string {
  return req.ip ?? req.socket?.remoteAddress ?? "";
}

/** Record the sign-in and (async) raise the new-device alert. Returns the ledger id. */
export async function noteSignIn(
  req: RequestLike,
  input: { userId: string; realm: Realm; method: SignInMethod; sessionId?: string | null },
): Promise<string> {
  const recorded = await recordSignIn({
    userId: input.userId,
    realm: input.realm,
    method: input.method,
    request: { headers: req.headers, ip: ipOf(req) },
    sessionId: input.sessionId ?? null,
  });
  if (recorded.newDevice) {
    void describeAccount(input.userId)
      .then((actor) => {
        if (actor) raiseNewDeviceAlert(actor, recorded);
      })
      .catch((error) => logger.error({ err: error }, "new-device alert account lookup failed"));
  }
  return recorded.row.id;
}

/** True when the user must reset their password before any new session. */
export async function forcedResetPending(userId: string): Promise<boolean> {
  const state = await loadSecurityState(userId);
  return Boolean(state?.force_password_reset);
}

export const SESSION_SIGN_OUT_FAILED_CODE = "SESSION_SIGN_OUT_FAILED";
export const SESSION_SIGN_OUT_FAILED_MESSAGE =
  "We could not sign out the other devices on this account just now, so nothing was changed. Try again in a moment.";

/**
 * Thrown when GoTrue refuses to end sessions. Containment flows treat this as
 * a hard stop BEFORE they change anything, so the caller can retry with the
 * same proof and no response ever claims a sign-out that did not happen.
 */
export class SessionContainmentError extends Error {
  readonly code = SESSION_SIGN_OUT_FAILED_CODE;
  constructor() {
    super(SESSION_SIGN_OUT_FAILED_MESSAGE);
    this.name = "SessionContainmentError";
  }
}

/** Express reply for a SessionContainmentError: retryable, honest, no state. */
export function respondSessionContainmentFailed(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  message: string = SESSION_SIGN_OUT_FAILED_MESSAGE,
): void {
  res.status(502).json({ error: message, code: SESSION_SIGN_OUT_FAILED_CODE, retryable: true });
}

/**
 * Recovery step one, run BEFORE the proof is consumed or the password moves:
 * every existing session goes (the person who recovered may not be the
 * person holding the old phone). If GoTrue refuses, nothing has changed yet
 * and the route answers with a retryable failure.
 */
export async function sweepSessionsBeforeRecovery(req: RequestLike, userId: string): Promise<void> {
  const loggedOut = await adminLogoutAll(userId);
  if (loggedOut) return;
  req.log?.error({ userId }, "recovery global logout failed");
  throw new SessionContainmentError();
}

/**
 * Recovery finished after a confirmed sweep: the ledger records why the
 * sessions ended, the forced-reset flag clears, and the event is audited.
 */
export async function afterRecoveryCompleted(req: RequestLike, input: { userId: string; patientId: string; providerId: string | null; requestId: string | null }): Promise<void> {
  await Promise.all([
    markRevoked({ userId: input.userId, reason: "recovery" }).catch((error) => req.log?.error({ err: error }, "recovery ledger revoke failed")),
    setForcedReset(input.userId, false, null).catch((error) => req.log?.error({ err: error }, "recovery forced-reset clear failed")),
  ]);
  void recordAdminAuditEvent({
    action: "security_recovery_completed",
    actorUserId: input.userId,
    actorKind: "patient",
    providerId: input.providerId,
    targetKind: "patient",
    targetId: input.patientId,
    requestId: input.requestId,
    metadata: { sessions: "signed_out" },
  }).catch((error) => req.log?.error({ err: error }, "recovery audit failed"));
}
