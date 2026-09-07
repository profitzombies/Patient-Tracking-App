/**
 * Expo push service client.
 *
 * Two calls, both documented at https://docs.expo.dev/push-notifications/sending-notifications/:
 *   POST https://exp.host/--/api/v2/push/send          -> one ticket per message
 *   POST https://exp.host/--/api/v2/push/getReceipts   -> receipts keyed by ticket id
 *
 * The client is an interface so the sender's tests run against an in-memory
 * fake (see fake-push.ts); the real implementation below is thin fetch glue.
 * Transport failures (network, 5xx, 429) throw PushTransportError so the
 * sender can retry with backoff; per-message problems come back as error
 * tickets/receipts and are handled individually.
 *
 * EXPO_ACCESS_TOKEN is optional: Expo only requires it once "Enhanced push
 * security" is enabled for the project. When set it rides as a bearer token.
 */

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  channelId?: string;
  priority?: "default" | "normal" | "high";
  badge?: number;
}

export type PushErrorCode =
  | "DeviceNotRegistered"
  | "InvalidCredentials"
  | "MessageTooBig"
  | "MessageRateExceeded"
  | "MismatchSenderId"
  | "ExpoError"
  | string;

export type PushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: PushErrorCode; expoPushToken?: string } };

export type PushReceipt =
  | { status: "ok" }
  | { status: "error"; message: string; details?: { error?: PushErrorCode } };

export interface ExpoPushClient {
  /** Tickets come back in the same order as `messages`. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Receipts for the given ticket ids; ids the service has not resolved yet are absent. */
  getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

export class PushTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PushTransportError";
  }
}

/** Errors that mean "this token is dead; stop sending to it". */
export function isTokenDeadError(code: PushErrorCode | undefined): boolean {
  return code === "DeviceNotRegistered";
}

/** Errors the service reports per message that are worth another try later. */
export function isTransientPushError(code: PushErrorCode | undefined): boolean {
  return code === "MessageRateExceeded" || code === "ExpoError" || code === undefined;
}

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo accepts at most 100 messages / 1000 receipt ids per request. */
export const MAX_MESSAGES_PER_REQUEST = 100;
export const MAX_RECEIPTS_PER_REQUEST = 1000;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && /^Expo(nent)?PushToken\[[A-Za-z0-9_:-]{1,200}\]$/.test(value);
}

export function createExpoPushClient(options: {
  fetchImpl?: typeof fetch;
  accessToken?: string | null;
  timeoutMs?: number;
} = {}): ExpoPushClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
  };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  async function post(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new PushTransportError(
        error instanceof Error ? `push service unreachable: ${error.message}` : "push service unreachable",
        null,
      );
    } finally {
      clearTimeout(timer);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      const detail =
        json && typeof json === "object" && Array.isArray((json as { errors?: unknown }).errors)
          ? JSON.stringify((json as { errors: unknown[] }).errors).slice(0, 300)
          : "";
      throw new PushTransportError(`push service responded ${response.status} ${detail}`.trim(), response.status);
    }
    return json;
  }

  return {
    async send(messages) {
      const tickets: PushTicket[] = [];
      for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
        const chunk = messages.slice(i, i + MAX_MESSAGES_PER_REQUEST);
        const json = (await post(EXPO_PUSH_SEND_URL, chunk)) as { data?: unknown } | null;
        const data = json && Array.isArray(json.data) ? (json.data as PushTicket[]) : null;
        if (!data || data.length !== chunk.length) {
          throw new PushTransportError("push service returned a malformed ticket list", 200);
        }
        tickets.push(...data);
      }
      return tickets;
    },
    async getReceipts(ticketIds) {
      const receipts: Record<string, PushReceipt> = {};
      for (let i = 0; i < ticketIds.length; i += MAX_RECEIPTS_PER_REQUEST) {
        const chunk = ticketIds.slice(i, i + MAX_RECEIPTS_PER_REQUEST);
        const json = (await post(EXPO_PUSH_RECEIPTS_URL, { ids: chunk })) as { data?: unknown } | null;
        const data = json && json.data && typeof json.data === "object" ? (json.data as Record<string, PushReceipt>) : null;
        if (!data) throw new PushTransportError("push service returned a malformed receipt map", 200);
        Object.assign(receipts, data);
      }
      return receipts;
    },
  };
}
