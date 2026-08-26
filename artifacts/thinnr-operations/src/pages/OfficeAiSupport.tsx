/**
 * AI Support — the office's live chat over the HQ knowledge library.
 *
 * Providers ask program questions and get comprehensive, markdown-formatted
 * answers streamed from /api/support/chat, grounded ONLY in the knowledge
 * documents HQ uploaded (two-stage routing happens server-side). Unlike the
 * patient coach's texting style, these replies use headers, bullets and bold
 * — never emojis — so assistant bubbles render sanitized markdown.
 *
 * The page is a thin header over the shared SupportChat surface: the SAME
 * component backs the HQ admin test bench, so chat fixes land in both
 * places. Chats are not persisted — each visit starts fresh by design.
 *
 * Open in the demo posture: reaching this page is enough — no staff sign-in,
 * no gate copy. Every visitor (demo personas included) gets the composer;
 * the server bounds spend with per-IP rate limits instead.
 */
import { MICRO_LABEL } from '@/components/patient/heritage';
import { SupportChat } from '@/components/support/SupportChat';

export default function OfficeAiSupport() {
  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col px-4 pb-4 pt-6 sm:px-5 sm:pb-5 sm:pt-7 md:px-8">
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

      <div className="flex min-h-0 flex-1 flex-col pt-5">
        <SupportChat
          intro={{
            title: 'Ask the knowledge library',
            description:
              'Comprehensive answers, grounded in the THINNR documents. If the documents do not cover it, you will hear that honestly instead of a guess.',
          }}
        />
      </div>
    </div>
  );
}
