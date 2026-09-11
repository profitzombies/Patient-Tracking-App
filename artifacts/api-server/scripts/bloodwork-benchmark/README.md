# Bloodwork document speed benchmark

See [RESULTS.md](RESULTS.md) for measured results, including limits and failures.

`run.ts` is the native-phase profiler; it replaces the earlier scheduler
simulation. It compares the document-worker files at git commit
`c2a1caa3b16191d1aba39430f26660566d598a98` with the working tree.

## Run

From the repository root, run the repeatable native/parser comparison:

```sh
pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-benchmark/run.ts \
  --phase both --repeats 2 --skip-ai --output /tmp/bloodwork-speed-native.json
```

With the configured OpenAI integration, run the current implementation's
separate real-AI comparison (one matrix pass):

```sh
pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-benchmark/run.ts \
  --phase after --repeats 1 --real-ai --output /tmp/bloodwork-speed-real-ai.json
```

## Method and boundaries

The 9-report matrix includes born-digital, scanned, and mixed PDFs at 1, 2,
and 6 pages. Every fixture page references `report.pages[0].bytes`: the
complete original PDF, not a synthetic one-page fragment.

* **Before:** materialized git-head document worker, full inspection, and its
  legacy single-page render operation.
* **After:** current inspection receipt and `prepareBloodworkPages` in
  batches of at most two pages. Six-page reports run as a four-page quantum
  followed by two pages.
* Four fixture-local reports run concurrently, exercising the real
  one-worker/four-queue document backpressure. Native call wall-clock includes
  actual queue delay; the harness does not calculate or invent queue time.
* Each page has a fixture-local save checkpoint, and the final aggregate is
  sorted by source page before being persisted.
* Deterministic runs record synthetic fixture rows and are explicitly **not**
  AI results. `--real-ai` uses the configured extraction API with a global
  concurrency limit of two and records only observer usage totals/availability.

The harness uses actual isolated native PDF parsing/rasterization, but its
repository, checkpoint, and aggregate adapters are fixture-local. It is not
live HTTP, database, or object-storage evidence, and it never writes raw model
responses or synthetic page bytes into evidence.

Independent live development proof is retained separately at
`scripts/bloodwork-benchmark/evidence/live-six-page.json`. It covers one
six-page mixed PDF through HTTP, object storage, Supabase, the four-page plus
two-page extraction continuation, and UI completion. Do not overwrite it from
this harness; its upload-to-complete wall-clock and uploader transport are
explicitly null/unknown.

## Controlled full-worker comparison

The opt-in Vitest harness runs the actual old/new orchestration, document
subprocesses, scheduler and memory job store. Both phases deliberately use the
same current transcriber to isolate orchestration changes. Storage and RPC
adapters remain fixture-local; this is not a historical live-production baseline.

```sh
BLOODWORK_PERFORMANCE=1 pnpm --filter @workspace/api-server exec vitest run \
  src/bloodwork/performance.benchmark.test.ts --reporter=dot
```

Run this long command with a managed background command or workflow, not
`nohup`. Each completed case is checkpointed with implementation, fixture and
methodology hashes. Matching cases resume and retain their original timestamps.
For a fresh measurement, archive the evidence and remove only
`evidence/e2e-worker-performance-latest.json.checkpoint.json` first.
The matrix uses an explicitly accelerated 100ms scheduling cadence; it must
not be described as measuring the production polling delay.

A separate, zero-model-request observation uses the real original 60-second
timer, native rendering and deterministic synthetic transcription rows:

```sh
BLOODWORK_PERFORMANCE_POLL_ONLY=1 pnpm --filter @workspace/api-server exec vitest run \
  src/bloodwork/performance.benchmark.test.ts --reporter=dot
```

The full matrix fails its assertion if any report fails or has mismatched
rows, while preserving completed-case evidence. A failed report is not a
successful timing sample and must not be omitted from the conclusions.

## Live HTTP measurement

This creates and cleans up only new, fixture-owned synthetic accounts/data.
It does not reprocess existing reports or create a browser session helper.
`benchmark-live` defaults to the existing six-page measurement. Pass the strict
`--pages 12` option to exercise a twelve-page mixed PDF; `--pages 6` explicitly
selects the default-sized run. Each page count writes its own wall-clock
evidence file (`live-six-page-wallclock.json` or
`live-twelve-page-wallclock.json`) and asserts the matching page count and six
synthetic rows per page. A timeout or extraction failure writes metadata-only
failure evidence to the matching path (`status`, `stage`, elapsed time, and
last observed processing status/phase/page counters; no report or identity
IDs) before the command exits.

```sh
export BLOODWORK_SMOKE_API_BASE_URL="https://$REPLIT_DEV_DOMAIN/api"
pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts prepare
pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts prepare-ui --no-helper
pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts benchmark-live --pages 12
pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts cleanup
```

Always run cleanup, including after a failed measurement. Do not run the live
measurement alongside the controlled matrix.