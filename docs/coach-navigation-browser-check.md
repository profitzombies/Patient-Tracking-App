# Coach navigation browser check

Task 524, one synthetic Expo browser session. Viewport: `393x852`. No real
account, token, production endpoint, or database data was used; all `/api/**`
traffic was intercepted by `scripts/coach-browser-fixture.cjs`.

## Verified

- Startup/admission and Coach history loading were verified earlier in this
  session. Held list showed the history header, back/New Chat, tabs, memories,
  and loading skeleton; release showed the synthetic meal-planning and failed
  follow-up rows.
- Held thread navigation reached `/coach-chat` in **742 ms** with `thread:1`.
  Header and loading transcript were visible, with no old transcript and
  disabled composer. After release, the saved transcript appeared in **34 ms**.
- Fresh warm cycle: after a new thread response, back took **609 ms** and did
  not add a list request; immediate reopen took **627 ms** and did not add a
  thread request. Counts remained `list:3`, `thread:2`.
- TTL correction: `fixture.requests()` records operation/method/path/query and
  sequence number, but no timestamps. The persisted marker showed **36,868 ms
  (~36.9 s)** elapsed when the earlier `list:2` observation was inspected.
  Therefore that list refresh was outside the 15-second TTL and was not a
  cache bug. An exact list-response-to-back-request duration was not available.
- Existing-thread draft/Stop: draft
  `Draft only - please remember this.` survived blur/focus. Held SSE showed
  `coach-stop`; counts were `append:1`, `stream:1`, `create:0`. Stop left the
  user row, removed Stop, and produced no duplicate request. No partial
  assistant text remained visible after the held response was stopped.
- New Chat first send: fresh greeting was
  `Hi. What would you like help with today?` with no old transcript and no
  eager create. One send created exactly one thread (`create:1`). The created
  row was reopened and visually confirmed at `/coach-chat` with the greeting
  `Hi. What would you like help with today?` and user message
  `What should I eat today?`. Final observed totals included
  `create:1`, `append:3`, `stream:2`; append may represent separate user and
  assistant operations.
- Cold transcript failure/retry (not Retry Processing): armed
  `failNext('thread',{status:503})` before opening `Synthetic follow-up`.
  `/coach-chat` showed `Synthetic cold transcript failure.`, a visible retry
  control, empty/non-falsely-loaded transcript, and disabled composer. The
  visible retry then succeeded: the page remained `/coach-chat` and displayed
  `This synthetic conversation is available for retry-processing checks.`;
  no `retryProcessing` request was made. The retry assertion initially needed
  a `:visible` locator because two same-testid retry nodes existed, one hidden.

## Notes

The app repeatedly reset to `/today` during earlier HMR/navigation attempts;
after Metro settled, recovery to history, reopening the created thread, and the
cold 503→Retry flow remained stable. Startup generated unrelated synthetic 501
unsupported calls and browser deprecation warnings; these did not block the
verified flows.