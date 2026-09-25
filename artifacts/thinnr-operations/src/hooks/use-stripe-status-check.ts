import { useCallback, useEffect, useRef, useState } from 'react';
import { BillingApiError, officeBilling } from '@/lib/billing-api';
import { stripeFormSubmitted } from '@/lib/stripe-connect-status';

/**
 * When to ask Stripe again, in ms after the check starts (about 15 seconds in
 * all). Stripe can take a few seconds to mark a just-submitted form, and its
 * webhook may land later still, so a single read is not enough.
 */
let CHECK_SCHEDULE_MS = [0, 2_000, 5_000, 10_000, 15_000];

/** Test seam: shorten the schedule so suites do not wait real seconds. */
export function setStripeCheckScheduleForTests(schedule: number[]) { CHECK_SCHEDULE_MS = schedule; }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pull the connected account's latest status from Stripe (the server stores
 * it), a few times over ~15 seconds, until the form reads as submitted. The
 * stored status otherwise only moves on Stripe's webhook or a stale read, so
 * without this an office that just submitted still looks unsubmitted.
 *
 * `onUpdated` runs after the check ends so screens re-read what was stored.
 * A new check, or unmounting, abandons the one in flight.
 */
export function useStripeStatusCheck({ office, onUpdated }: { office: string | null; onUpdated: () => Promise<unknown> | void }) {
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  useEffect(() => () => { generation.current += 1; }, []);

  const check = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => generation.current === mine;
    setChecking(true);
    let elapsed = 0;
    try {
      for (const at of CHECK_SCHEDULE_MS) {
        if (at > elapsed) { await wait(at - elapsed); elapsed = at; }
        if (!current()) return;
        try {
          const { account } = await officeBilling.sync(office);
          if (!current()) return;
          if (stripeFormSubmitted(account)) break;
        } catch (failure) {
          // No account, no permission or a bad request will not change on a
          // retry; a Stripe or network hiccup might.
          if (failure instanceof BillingApiError && failure.status >= 400 && failure.status < 500) break;
        }
      }
      if (current()) await onUpdatedRef.current();
    } finally {
      if (current()) setChecking(false);
    }
  }, [office]);

  return { checking, check };
}
