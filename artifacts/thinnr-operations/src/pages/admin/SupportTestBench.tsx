/**
 * Test AI Support — the HQ admin bench for the knowledge base.
 *
 * Mounts the SAME SupportChat component the office AI Support page uses, so
 * HQ hears exactly what offices hear after editing the knowledge library —
 * and any chat fix lands in both places. Bench posture extras: the
 * clear-conversation control, so each probe can start from a clean thread.
 * Nothing is persisted; clearing is purely client-side.
 */
import { MICRO_LABEL } from '@/components/patient/heritage';
import { SupportChat } from '@/components/support/SupportChat';

export default function SupportTestBench() {
  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col px-4 pb-4 pt-6 sm:px-5 sm:pb-5 sm:pt-7 md:px-8">
      <header className="shrink-0">
        <p className={MICRO_LABEL}>Learning · Knowledge library</p>
        <h1 className="mt-1 font-serif text-[32px] leading-none tracking-[-.02em] text-navy">
          Test AI Support
        </h1>
        <p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-muted-foreground">
          Chat with the same assistant your offices use. Answers come only from the knowledge
          documents in the library, so this is the fastest way to confirm what they really say.
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col pt-5">
        <SupportChat
          showClear
          intro={{
            title: 'Test the knowledge base',
            description:
              'Ask what an office might ask and confirm the documents answer it the way you expect. Conversations are not saved — clear the thread to start a fresh test.',
          }}
        />
      </div>
    </div>
  );
}
