import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

type RequestObserver = (input: { url: string; method: string }) => void;

const requestObservers = new Set<RequestObserver>();

/**
 * Called once per HTTP request the shared client makes (before it is sent).
 * The API server uses this to mark the current request as AI-backed for its
 * request log and latency metrics. Observers must not throw; a throwing
 * observer is dropped from the set so it cannot take the model call down.
 */
export function observeOpenAIRequests(observer: RequestObserver): () => void {
  requestObservers.add(observer);
  return () => {
    requestObservers.delete(observer);
  };
}

const observedFetch: typeof fetch = (input, init) => {
  if (requestObservers.size) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET");
    for (const observer of requestObservers) {
      try {
        observer({ url, method });
      } catch {
        requestObservers.delete(observer);
      }
    }
  }
  return fetch(input, init);
};

export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  fetch: observedFetch,
});
