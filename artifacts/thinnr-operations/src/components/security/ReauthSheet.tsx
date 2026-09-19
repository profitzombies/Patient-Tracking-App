import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';

interface StartResponse {
  requestId: string;
  destination: string;
  devCode?: string;
}

interface ReauthSheetProps {
  open: boolean;
  onResolve: (confirmed: boolean) => void;
}

async function authenticatedPost(path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error('Your session has ended. Sign in again to continue.');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has ended. Sign in again to continue.');

  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? JSON.stringify({}) : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Could not confirm your identity. Try again.');
  }
  return result;
}

export function ReauthSheet({ open, onResolve }: ReauthSheetProps) {
  const [request, setRequest] = useState<StartResponse | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setRequest(null);
      setCode('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const sendCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authenticatedPost('/api/security/me/reauth/start');
      setRequest({
        requestId: String(result.requestId),
        destination: String(result.destination),
        ...(typeof result.devCode === 'string' ? { devCode: result.devCode } : {}),
      });
      setCode('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send a code right now.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !request) return;
    if (code.length !== 6) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authenticatedPost('/api/security/me/reauth/verify', {
        requestId: request.requestId,
        code,
      });
      onResolve(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not verify that code.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => onResolve(false);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && open) cancel();
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>
            {request
              ? `We sent a code to ${request.destination}.`
              : "For security, this action needs a fresh sign-in code. We'll email one to your work email."}
          </DialogDescription>
        </DialogHeader>

        {!request ? (
          <Button type="button" onClick={sendCode} disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </Button>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <div>
              <Label htmlFor="reauth-code">6-digit code</Label>
              <Input
                id="reauth-code"
                data-testid="input-reauth-code"
                className="mt-1.5 text-center text-lg font-semibold tracking-[.4em]"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                disabled={busy}
                autoFocus
              />
            </div>
            {request.devCode && (
              <p className="text-xs text-muted-foreground">Dev delivery mode — your code is {request.devCode}.</p>
            )}
            <Button type="submit" data-testid="button-reauth-verify" className="w-full" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
            <button
              type="button"
              onClick={sendCode}
              disabled={busy}
              className="w-full text-xs font-semibold text-primary underline-offset-2 hover:underline"
            >
              Resend code
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" data-testid="button-reauth-cancel" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}