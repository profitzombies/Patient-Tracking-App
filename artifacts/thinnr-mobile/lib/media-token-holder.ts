/**
 * Patient-scoped media read token — module-held, dependency-free.
 *
 * The server mints the token on every authenticated state hydrate and
 * GET /patient-media/file requires it: <Image> can't send bearer headers,
 * so read authorization rides the display URL. The holder lives in its own
 * import-free module because both URL builders (patient-data-api's library
 * builder and progress-photo-upload's grid builder) and PatientContext's
 * account-switch hygiene need it — and the Node test runners stub heavy
 * modules per suite, so the shared seam must not drag any dependency into
 * a suite's module graph.
 *
 * Cleared on account switch; never set for the demo persona (which never
 * hydrates from the server), so demo URLs stay token-free.
 */
let mediaReadToken: string | null = null;

export function setPatientMediaToken(token: string | null): void {
  mediaReadToken = token;
}

/** Append the current token to a /patient-media/file URL, when one is held. */
export function appendMediaToken(url: string): string {
  return mediaReadToken ? `${url}&mt=${encodeURIComponent(mediaReadToken)}` : url;
}
