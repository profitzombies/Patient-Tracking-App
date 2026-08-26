/**
 * AI Support — the office's live chat over the HQ knowledge library.
 *
 * Providers ask program questions and get comprehensive, markdown-formatted
 * answers streamed from /api/support/chat, grounded ONLY in the knowledge
 * documents HQ uploaded (two-stage routing happens server-side). Unlike the
 * patient coach's texting style, these replies use headers, bullets, bold and
 * emojis — so assistant bubbles render sanitized markdown (react-markdown
 * with no raw-HTML pass-through).
 *
 * Reliability contract mirrors the coach client: streamed deltas, a Stop
 * button that keeps the partial text (flagged stopped for the model), errors
 * replace partial replies with a retryable notice, and a dropped stream never
 * finalizes as a complete answer. Chats are not persisted — each visit starts
 * fresh by design.
 *
 * Open in the demo posture: reaching this page is enough — no staff sign-in,
 * no gate copy. Every visitor (demo personas included) gets the composer;
 * the server bounds spend with per-IP rate limits instead.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpenText, RotateCcw, Sparkles, Square } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MICRO_LABEL } from '@/components/patient/heritage';
import {
  streamSupportChat,
  toHistoryContent,
  type SupportChatMessagePayload,
} from '@/lib/support-chat';

interface SupportMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
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

export default function OfficeAiSupport() {
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const replyIdRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Abort any in-flight stream when the provider leaves the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Follow the stream, but only while the provider is already near the
  // bottom — scrolling up to reread an earlier answer must stay put.
  useEffect(() => {
    if (!streaming) return;
    const sentinel = endRef.current;
    if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 320) {
      sentinel.scrollIntoView({ block: 'end' });
    }
  }, [messages, streaming]);

  const send = (question: string) => {
    const trimmed = question.trim().slice(0, MAX_QUESTION_LENGTH);
    if (!trimmed || streaming) return;
    setError(null);
    setDraft('');

    const userMessage: SupportMessage = { id: nextId(), role: 'user', text: trimmed };
    const replyId = nextId();
    replyIdRef.current = replyId;
    const history = [...messages, userMessage];
    setMessages([...history, { id: replyId, role: 'assistant', text: '' }]);
    setStreaming(true);

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
        onDelta: (text) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === replyId ? { ...message, text: message.text + text } : message,
            ),
          );
        },
        onDone: () => {
          setStreaming(false);
          replyIdRef.current = null;
        },
        onError: (message, retryable) => {
          // Partial text would read as a complete answer — replace it with
          // the error notice; RETRY replays the question.
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
    <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col px-4 pt-6 sm:px-5 sm:pt-7 md:px-8">
      <header className="shrink-0">
        <p className={MICRO_LABEL}>Learning · Knowledge library</p>
        <h1 className="mt-1 font-serif text-[32px] leading-none tracking-[-.02em] text-navy">
          AI Support
        </h1>
        <p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-muted-foreground">
          Ask about the THINNR program on behalf of a patient. Answers come only from the
          knowledge documents HQ has uploaded, so they match the protocol your office follows.
        </p>
      </header>

      {/* The conversation (or the empty-state intro) */}
      <div className="flex flex-1 flex-col pt-5">
        {!hasConversation && (
          <div className="flex flex-1 items-center justify-center pb-6">
            <div className="w-full max-w-[560px] rounded-lg border border-card-border bg-card px-5 py-6 text-center shadow-soft">
              <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary">
                <Sparkles size={18} aria-hidden="true" />
              </span>
              <h2 className="mt-3 font-serif text-[19px] leading-snug text-navy">
                Ask the knowledge library
              </h2>
              <p className="mx-auto mt-1.5 max-w-[420px] text-xs leading-relaxed text-muted-foreground">
                Comprehensive answers, grounded in the THINNR documents. If the documents do not
                cover it, you will hear that honestly instead of a guess.
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
        )}

        {hasConversation && (
          <div className="space-y-4 pb-4" data-testid="list-support-messages">
            {messages.map((message, index) =>
              message.role === 'user' ? (
                <div key={message.id} className="flex justify-end">
                  <div
                    className="max-w-[88%] rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 shadow-xs md:max-w-[72%]"
                    data-testid={`text-message-${index}`}
                  >
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-primary-foreground">
                      {message.text}
                    </p>
                  </div>
                </div>
              ) : (
                <div key={message.id} className="flex justify-start">
                  <div className="max-w-[92%] md:max-w-[80%]">
                    <div
                      className="rounded-lg rounded-bl-sm border border-card-border bg-card px-4 py-3 shadow-soft"
                      data-testid={`text-message-${index}`}
                    >
                      {message.text.length === 0 ? (
                        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                          <Sparkles size={13} aria-hidden="true" className="animate-pulse text-primary" />
                          Searching the knowledge documents…
                        </p>
                      ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {message.text}
                        </ReactMarkdown>
                      )}
                    </div>
                    {message.stopped && (
                      <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                        Stopped
                      </p>
                    )}
                  </div>
                </div>
              ),
            )}
            <div ref={endRef} aria-hidden="true" />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3"
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

        {/* Composer — sticks to the bottom of the scroll area */}
        <div className="sticky bottom-0 mt-auto shrink-0 bg-gradient-to-t from-background via-background to-transparent pb-4 pt-2 sm:pb-5">
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
    </div>
  );
}
