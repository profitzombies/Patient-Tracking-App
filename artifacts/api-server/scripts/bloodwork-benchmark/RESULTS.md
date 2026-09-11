# Bloodwork processing measurements

Measured on 2026-09-11 using synthetic PDFs only. These are development
measurements, not promised patient upload times or a production SLA.

## What changed

- New immutable uploads receive a validated byte digest. Bounded isolated
  operations reuse that admission proof and open each requested two-page batch
  once, instead of walking the complete PDF for every page.
- Two page transcription requests can overlap; native rendering remains
  independently bounded to one worker and its existing bounded queue.
- Commits and four-page continuations signal the existing leased scheduler.
  Durable scheduled fallback, fair rotation, checkpoints and atomic ordered
  completion remain in place.
- Page checkpoints survive sibling failures. Account purge revokes work, and
  a fresh lease proof after rendering prevents starting the next AI wave after
  revocation. A run-budget boundary yields work instead of terminally failing it.
- Mobile screens show targeted loaders and real processing state/counts.
  History refreshes after commit; source images and loaded content remain stable.

The 20 MB / 100-page limits, isolation safeguards, source provenance, privacy,
correction conflicts and unreviewed status were retained. There is no new OCR
detour or text-layer fast path: source fidelity for such a path was not proven.

## Native phase: repeatable improvement, not total upload time

`evidence/native-two-repeat.json` contains two repetitions of born-digital,
scanned and mixed PDFs at 1, 2 and 6 pages: 54 pages per phase.

Aggregate native-call elapsed time, including actual native-worker queue wait,
fell from **171.54 seconds to 94.21 seconds (45.1%)**. Every page checkpoint
completed. Admission inspection totals were 42.05 versus 42.83 seconds.
These sums are not end-to-end wall-clock or network/database timings.

## Controlled orchestration with real AI

`evidence/e2e-worker-performance-latest.json` uses actual old/new orchestration,
the same current transcriber, native parsing, fixture-local storage/RPCs and
an explicitly accelerated 100ms polling cadence. It isolates orchestration;
it does not reconstruct the complete historical production environment.

| PDF | Pages | Before wall seconds | After wall seconds | After outcome |
|---|---:|---:|---:|---|
| Born-digital | 1 | 3.641 | 3.494 | Exact |
| Born-digital | 2 | 8.028 | 4.399 | Exact |
| Born-digital | 6 | 22.641 | 35.406 | Exact |
| Scanned | 1 | 5.320 | 5.911 | Exact |
| Scanned | 2 | 17.807 | 6.591 | Exact |
| Scanned | 6 | 32.467 | 45.433 | Exact |
| Mixed | 1 | 4.981 | 4.686 | Exact |
| Mixed | 2 | 17.950 | 4.942 | Exact |
| Mixed | 6 | 25.043 | 40.912 to failure | AI timeout; 4 pages retained |

All 17 completed cases had exact ordered rows. The failed case did not publish
partial results. Across the eight matched successful pairs, summed elapsed
time changed from 112.83 to 110.86 seconds, only **1.75% lower**. Some long
reports were slower because of model latency. This run does **not** establish
a general end-to-end AI speedup; network/model tails remain significant.
Per-case upload, inspection, queue, render, transcription, save, aggregation
and observed usage fields are in the JSON. Token totals cover reported usage
only; timed-out requests may have unreported usage. Dollar cost was unavailable.

The matrix evidence was recovered unchanged from its atomic checkpoints.
A following polling-only observation initially failed because startup waited
an entire first interval. That harness issue did not invalidate the matrix.
It was corrected and measured separately; historical source hashes identify
the matrix version, before the polling-only fix.

## Real polling interval

`evidence/original-poll-observation.json` observed the original scheduler with
a real 60,000ms timer, native PDF rendering and deterministic fixture rows
(no model calls or accuracy claims). It processed four pages, waited
**58.406 seconds**, then processed the remaining two. Total observed worker
wall time was 60.803 seconds. No predicted or manually added wait was used.
Current continuations are signaled immediately instead of requiring that tick.

## Live development HTTP / object storage / Supabase

`evidence/live-six-page-wallclock.json` measured a new six-page mixed PDF:

| Client phase | Time |
|---|---:|
| Create upload | 0.960 s |
| Upload transfer | 0.311 s |
| Commit request | 2.646 s |
| Poll until completed detection | 17.381 s |
| **Create through completed detection** | **21.302 s** |

All 36 rows and six source pages matched exactly; the result stayed unreviewed.
This is one live sample, not a before/after production claim.

Earlier browser verification independently confirmed upload, navigation away,
reopening, completed results, distinct source-page images and reload persistence.
Its server/UI extraction elapsed was 18 seconds; that is not its total upload
wall time. `evidence/live-six-page.json` retains detailed server-side phase
metrics from that earlier sample.

## Vision model decision

See `evidence/accuracy-conclusion.md` and its exact-field evidence. Terra and
Luna passed clear digital, scanned, poor scanned and visible 201-row overflow
checks. Luna did not show a consistent latency advantage. Mini was faster on
ordinary pages but its corrected overflow test received no response and is
not qualified. **Terra remains the production model.**

Evidence contains no patient data, raw model replies, document text, private
URLs or credentials. Synthetic fixture accounts, files and temporary helpers
were removed after live verification.