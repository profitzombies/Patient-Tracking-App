/**
 * SupportChat — the shared AI Support conversation surface.
 *
 * One implementation serves two mounts — the office AI Support page and the
 * HQ admin test bench — so a chat fix lands in both. The component owns the
 * whole conversation lifecycle:
 *
 * - Streaming send/stop/retry with the coach client's reliability contract
 *   (partial text kept on Stop and flagged for the model, errors replace
 *   partial replies with a retryable notice, dropped streams never finalize).
 * - A three-dot thinking indicator whose status line follows the server's
 *   REAL stage events (searching the knowledge documents → thinking →
 *   formulating a response). The StagePacer guarantees each displayed label
 *   its minimum beat AND holds the first answer text until the narration
 *   has played out — server stages often land in the same network read as
 *   the first content chunk, and unpaced text would blink the label away.
 *   A timed fallback walks the same progression if an older server sends
 *   no stage events at all; Stop and errors fast-forward instead of waiting.
 * - Per-message timestamps, rendered under each bubble.
 * - Pin-to-bottom scrolling: sending snaps the conversation down, streaming
 *   keeps it pinned, and a reader who deliberately scrolls up is left alone
 *   until they return to the bottom (or send again).
 *
 * Layout contract: the host page provides a definite-height flex column and
 * its own header; the conversation lives in a bordered white card that fills
 * the remaining space and scrolls internally, with the composer card below.
 * Chats are not persisted — each visit starts fresh by design, and the HQ
 * bench's clear control just empties client state.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpenText, Eraser, RotateCcw, Sparkles, Square } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MICRO_LABEL } from '@/components/patient/heritage';
import { StagePacer } from '@/lib/stage-pacer';
import {
  streamSupportChat,
  toHistoryContent,
  type SupportChatMessagePayload,
  type SupportChatStage,
} from '@/lib/support-chat';

interface SupportMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Creation time (ms epoch) — rendered as the bubble's timestamp. */
  at: number;
  /** The provider pressed Stop while this reply was streaming. */
  stopped?: boolean;
}

/** The server slices to its own window; this keeps request bodies small. */
const HISTORY_WINDOW = 12;
const MAX_QUESTION_LENGTH = 4000;

const SUGGESTED_QUESTIONS = [
  'What foods are approved during the thinning phase?',
  'How should a patient take Boost, and when?',
  'A patient reports headaches in week one. What does the protocol say?',
];

const STAGE_LABELS: Record<SupportChatStage, string> = {
  searching: 'Searching the knowledge documents…',
  thinking: 'Thinking…',
  formulating: 'Formulating a response…',
};

/** How close to the bottom (px) still counts as "reading the newest text". */
const PIN_THRESHOLD_PX = 80;

/**
 * Markdown building blocks styled to the operations design language. Links
 * open in a new tab; react-markdown never renders raw HTML, so document
 * content cannot inject markup into the page.
 */
const markdownComponents: Components = {
  h1: ({ children }) => (
    <h3 className="mt-4 font-serif text-[17px] leading-snug text-navy first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-4 font-serif text-[16px] leading-snug text-navy first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-3 text-[13px] font-bold text-navy first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="mt-3 text-[13px] font-semibold text-navy first:mt-0">{children}</h6>
  ),
  p: ({ children }) => (
    <p className="mt-2 text-[13px] leading-relaxed text-foreground first:mt-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed first:mt-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed first:mt-0">{children}</ol>
  ),
  li: ({ children }) => <li className="marker:text-primary">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-navy">{children}</strong>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l-2 border-accent-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[12px]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-3 text-[12px]">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-secondary px-2 py-1.5 text-left font-semibold text-navy">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1.5 align-top">{children}</td>
  ),
};

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `m${messageSeq}`;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The mobile coach's thinking wave, rebuilt for the web (CSS keyframes). */
function ThinkingDots() {
  return (
    <span className="flex h-[21px] shrink-0 items-center gap-[5px]" aria-hidden="true">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="support-thinking-dot h-1.5 w-1.5 rounded-[1.5px] bg-primary"
          style={{ animationDelay: `${dot * 170}ms` }}
        />
      ))}
    </span>
  );
}

export interface SupportChatProps {
  /** Empty-state intro copy, shown centered inside the conversation card. */
  intro: { title: string; description: string };
  /** Renders the clear-conversation control (the HQ test bench posture). */
  showClear?: boolean;
}

export function SupportChat({ intro, showClear = false }: SupportChatProps) {
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [stage, setStage] = useState<SupportChatStage>('searching');

  const abortRef = useRef<AbortController | null>(null);
  const replyIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** True while the reader is at (or near) the bottom of the conversation. */
  const pinnedRef = useRef(true);

  /**
   * The turn's narration pacer. Owns label beats, the held-text gate, the
   * no-stage fallback walk, and deferred finalization; a fresh instance is
   * created per send so late events from an old turn can never leak in.
   */
  const pacerRef = useRef<StagePacer | null>(null);

  // Abort any in-flight stream (and stray timers) when the page unmounts.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      pacerRef.current?.cancel();
    },
    [],
  );

  const scrollToBottom = () => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  };

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    pinnedRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < PIN_THRESHOLD_PX;
  };

  // Follow the stream while the reader is pinned to the bottom; a deliberate
  // scroll up unpins (handleScroll) and this effect leaves them alone.
  useEffect(() => {
    if (streaming && pinnedRef.current) scrollToBottom();
  }, [messages, streaming]);

  const send = (question: string) => {
    const trimmed = question.trim().slice(0, MAX_QUESTION_LENGTH);
    if (!trimmed || streaming) return;
    setError(null);
    setDraft('');

    const now = Date.now();
    const userMessage: SupportMessage = { id: nextId(), role: 'user', text: trimmed, at: now };
    const replyId = nextId();
    replyIdRef.current = replyId;
    const history = [...messages, userMessage];
    setMessages([...history, { id: replyId, role: 'assistant', text: '', at: now }]);
    setStreaming(true);
    const pacer = new StagePacer({
      onStageChange: setStage,
      onTextFlush: (text) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === replyId ? { ...message, text: message.text + text } : message,
          ),
        );
      },
      onFinalize: () => {
        setStreaming(false);
        replyIdRef.current = null;
      },
    });
    pacerRef.current?.cancel();
    pacerRef.current = pacer;
    pacer.start();
    // Sending always returns the reader to the newest exchange.
    pinnedRef.current = true;

    const payload: SupportChatMessagePayload[] = history
      .slice(-HISTORY_WINDOW)
      .map((message) => ({
        role: message.role,
        content: toHistoryContent(message.text),
        ...(message.stopped ? { stopped: true } : {}),
      }));

    const controller = new AbortController();
    abortRef.current = controller;
    void streamSupportChat(
      payload,
      {
        // The pacer decides WHEN each event reaches the screen: text waits
        // out the narration beats, `done` waits for the text it gated.
        onDelta: (text) => pacer.delta(text),
        onStage: (next) => pacer.serverStage(next),
        onDone: () => pacer.done(),
        onError: (message, retryable) => {
          // Partial text would read as a complete answer — replace it with
          // the error notice; RETRY replays the question. No fake beats on
          // failure: the pacer tears down silently.
          pacer.cancel();
          setMessages((current) => current.filter((entry) => entry.id !== replyId));
          setError({ message, retryable });
          setStreaming(false);
          replyIdRef.current = null;
        },
      },
      { signal: controller.signal },
    );
  };

  const stop = () => {
    // Fast-forward the pacer first: held text flushes NOW. If the stream
    // had already finished (done was riding out the narration), the reply
    // is complete — finalization has fired and "stopped" would be a lie.
    const wasDone = pacerRef.current?.finish() ?? false;
    if (wasDone) return;
    abortRef.current?.abort();
    const replyId = replyIdRef.current;
    setMessages((current) => {
      const reply = current.find((entry) => entry.id === replyId);
      if (!reply) return current;
      // Keep what already streamed, flagged so the model knows it was cut
      // off; an empty bubble just disappears.
      return reply.text.length > 0
        ? current.map((entry) => (entry.id === replyId ? { ...entry, stopped: true } : entry))
        : current.filter((entry) => entry.id !== replyId);
    });
    setStreaming(false);
    replyIdRef.current = null;
  };

  const retry = () => {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    // send() re-appends the question, so remove the failed attempt's copy.
    setMessages((current) => current.filter((entry) => entry.id !== lastUser.id));
    // React batches the two setMessages calls; compute from the same base.
    setTimeout(() => send(lastUser.text), 0);
  };

  /** Client-side reset for the test bench — nothing is stored anywhere. */
  const clearConversation = () => {
    abortRef.current?.abort();
    pacerRef.current?.cancel();
    replyIdRef.current = null;
    setMessages([]);
    setStreaming(false);
    setError(null);
    pinnedRef.current = true;
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  };

  const autosize = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  };

  const hasConversation = messages.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showClear && (
        <div className="mb-2 flex shrink-0 justify-end">
          <button
            type="button"
            onClick={clearConversation}
            disabled={!hasConversation && !error}
            data-testid="button-clear-conversation"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] font-semibold text-navy shadow-xs transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eraser size={12} aria-hidden="true" />
            Clear conversation
          </button>
        </div>
      )}

      {/* The conversation card — a bordered white box that scrolls inside. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="region-support-conversation"
        className="min-h-[180px] flex-1 overflow-y-auto rounded-lg border border-card-border bg-card shadow-soft"
      >
        {!hasConversation ? (
          <div className="flex h-full items-center justify-center px-5 py-6">
            <div className="w-full max-w-[560px] text-center">
              <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary">
                <Sparkles size={18} aria-hidden="true" />
              </span>
              <h2 className="mt-3 font-serif text-[19px] leading-snug text-navy">{intro.title}</h2>
              <p className="mx-auto mt-1.5 max-w-[420px] text-xs leading-relaxed text-muted-foreground">
                {intro.description}
              </p>
              <div className="mt-4 space-y-2">
                <p className={MICRO_LABEL}>Try asking</p>
                {SUGGESTED_QUESTIONS.map((question, index) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => send(question)}
                    data-testid={`button-suggested-${index}`}
                    className="block w-full rounded-md border border-border bg-paper-alt px-3.5 py-2.5 text-left text-xs leading-snug text-foreground transition hover:border-accent-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <BookOpenText size={12} aria-hidden="true" className="mr-2 inline-block text-primary" />
                    {question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-4 py-4 sm:px-5" data-testid="list-support-messages">
            {messages.map((message, index) =>
              message.role === 'user' ? (
                <div key={message.id} className="flex flex-col items-end">
                  <div
                    className="max-w-[88%] rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 shadow-xs md:max-w-[72%]"
                    data-testid={`text-message-${index}`}
                  >
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-primary-foreground">
                      {message.text}
                    </p>
                  </div>
                  <p
                    className="mt-1 text-[10px] text-muted-foreground"
                    data-testid={`text-timestamp-${index}`}
                  >
                    {formatTime(message.at)}
                  </p>
                </div>
              ) : (
                <div key={message.id} className="flex justify-start">
                  <div className="max-w-[92%] md:max-w-[80%]">
                    <div
                      className="rounded-lg rounded-bl-sm border border-card-border bg-card px-4 py-3 shadow-soft"
                      data-testid={`text-message-${index}`}
                    >
                      {message.text.length === 0 ? (
                        <div className="flex items-center gap-2.5">
                          <ThinkingDots />
                          <p
                            className="text-[13px] text-muted-foreground"
                            data-testid="status-support-stage"
                          >
                            {STAGE_LABELS[stage]}
                          </p>
                        </div>
                      ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {message.text}
                        </ReactMarkdown>
                      )}
                    </div>
                    {(message.text.length > 0 || message.stopped) && (
                      <p
                        className="mt-1 text-[10px] text-muted-foreground"
                        data-testid={`text-timestamp-${index}`}
                      >
                        {formatTime(message.at)}
                        {message.stopped && (
                          <span className="ml-1.5 font-bold uppercase tracking-[.12em]">
                            · Stopped
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3"
          data-testid="alert-support-error"
        >
          <p className="text-xs leading-relaxed text-destructive">{error.message}</p>
          {error.retryable && (
            <button
              type="button"
              onClick={retry}
              data-testid="button-retry"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] font-semibold text-navy shadow-xs transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw size={12} aria-hidden="true" />
              Try again
            </button>
          )}
        </div>
      )}

      {/* Screen readers hear turn boundaries, not every streamed chunk. */}
      <p aria-live="polite" className="sr-only">
        {streaming ? 'AI Support is answering.' : ''}
      </p>

      {/* Composer — always visible below the conversation card */}
      <div className="shrink-0 pt-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
          className="flex items-end gap-2 rounded-lg border border-card-border bg-card p-2 shadow-soft focus-within:ring-2 focus-within:ring-ring"
        >
          <label htmlFor="support-question" className="sr-only">
            Ask AI Support a question
          </label>
          <textarea
            id="support-question"
            ref={textareaRef}
            rows={1}
            value={draft}
            maxLength={MAX_QUESTION_LENGTH}
            placeholder="Ask about the THINNR program…"
            onChange={(event) => {
              setDraft(event.target.value);
              autosize(event.target);
            }}
            onKeyDown={handleComposerKeyDown}
            data-testid="input-support-question"
            className="max-h-40 min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          />
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop the reply"
              data-testid="button-stop"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-navy text-primary-foreground shadow-xs transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Square size={13} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={draft.trim().length === 0}
              aria-label="Send question"
              data-testid="button-send"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow-xs transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          )}
        </form>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          Answers come from the THINNR knowledge library. For anything it cannot cover, email{' '}
          <a href="mailto:Support@Thinnrweightloss.com" className="font-medium text-primary underline underline-offset-2">
            Support@Thinnrweightloss.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
