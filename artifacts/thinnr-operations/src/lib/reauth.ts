export class ReauthRequiredError extends Error {
  readonly code = 'reauth_required';

  constructor(message = "Confirm it's you with a fresh code to continue.") {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

type ReauthHandler = () => Promise<boolean>;

let handler: ReauthHandler | null = null;
let inFlight: Promise<boolean> | null = null;

export function isReauthRequired(status: number, body: unknown): boolean {
  return status === 401
    && Boolean(body)
    && typeof body === 'object'
    && (body as { code?: unknown }).code === 'reauth_required';
}

export function registerReauthHandler(nextHandler: ReauthHandler): () => void {
  handler = nextHandler;
  return () => {
    if (handler === nextHandler) handler = null;
  };
}

export async function requestReauth(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (!handler) return false;

  const currentHandler = handler;
  const pending = Promise.resolve().then(() => currentHandler());
  inFlight = pending;
  try {
    return await pending;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
}

async function responseNeedsReauth(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null);
  return isReauthRequired(response.status, body);
}

export async function withReauthRetry<T extends Response = Response>(
  perform: () => Promise<T>,
): Promise<T> {
  const response = await perform();
  if (!await responseNeedsReauth(response)) return response;

  if (!await requestReauth()) throw new ReauthRequiredError();
  return perform();
}