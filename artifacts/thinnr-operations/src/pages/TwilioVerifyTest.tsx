import { useState, type FormEvent } from 'react';
import { CheckCircle2, MessageSquareText, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Phase = 'phone' | 'code' | 'verified';

async function post<T>(path: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Try again.');
  return result;
}

export default function TwilioVerifyTest() {
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('+1 ');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await post<{ sent: boolean }>('/api/test/twilio/send', { phone });
      setCode('');
      setPhase('code');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The code could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const checkCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ verified: boolean }>('/api/test/twilio/check', { phone, code });
      if (result.verified) setPhase('verified');
      else setError("That code wasn't approved. Check it and try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The code could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f4f1e8] px-5 py-12 text-slate-950">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-[9px] bg-[#172d55] text-white">
            <ShieldCheck aria-hidden="true" size={23} />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.18em] text-[#315fa8]">THINNR</p>
            <h1 className="font-serif text-3xl font-semibold">Verify SMS test</h1>
          </div>
        </div>

        <section className="rounded-[9px] border border-[#d8d2c4] bg-[#fffdf7] p-6 shadow-sm">
          {phase === 'verified' ? (
            <div className="py-4 text-center" role="status">
              <CheckCircle2 className="mx-auto mb-4 text-emerald-600" size={48} />
              <h2 className="font-serif text-2xl font-semibold">Verified</h2>
              <p className="mt-2 text-sm text-slate-600">Twilio approved the code for {phone}.</p>
              <Button className="mt-6 w-full" onClick={() => setPhase('phone')}>
                Test another number
              </Button>
            </div>
          ) : phase === 'phone' ? (
            <form onSubmit={sendCode}>
              <MessageSquareText className="mb-4 text-[#315fa8]" aria-hidden="true" />
              <h2 className="font-serif text-2xl font-semibold">Send a test code</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Enter a mobile number with its country code. Twilio Verify will send the message.
              </p>
              <div className="mt-6 space-y-2">
                <Label htmlFor="test-phone">Phone number</Label>
                <Input
                  id="test-phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="+1 813 555 0123"
                  required
                />
              </div>
              {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
              <Button className="mt-6 w-full" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form onSubmit={checkCode}>
              <h2 className="font-serif text-2xl font-semibold">Enter the code</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                We requested a verification text for <strong>{phone}</strong>.
              </p>
              <div className="mt-6 space-y-2">
                <Label htmlFor="test-code">Verification code</Label>
                <Input
                  id="test-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  required
                  autoFocus
                />
              </div>
              {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
              <Button className="mt-6 w-full" type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Verify code'}
              </Button>
              <button
                className="mt-4 w-full text-sm font-medium text-[#315fa8] hover:underline"
                type="button"
                onClick={() => { setPhase('phone'); setError(null); }}
              >
                Use a different number
              </button>
            </form>
          )}
        </section>
        <p className="mt-4 text-center text-xs text-slate-500">
          Development diagnostic only. Sending and checking are rate limited.
        </p>
      </div>
    </main>
  );
}