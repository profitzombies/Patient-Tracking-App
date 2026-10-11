---
name: Diet programs foundation
description: Durable safety and design rules for the shared diet library, patient diet state, phase model, classifier/calculator parity and diet notifications.
---

# Diet programs (library, patient state, routes)

- **Canonical content lives in the workspace lib, not SQL.** The diet library seed migration is generated from the catalog in `lib/diet-programs`; never hand-edit the seed migration — regenerate and re-apply through the normal migration runner to both projects.
  **Why:** the same catalog feeds the classifier, the parity fixture, the OpenAPI enums and the DB seed; a hand edit in one place silently forks the others.
- **Phase comes from the open protocol episode, never from `program_start_date` alone.** Program day keeps the legacy whole-day semantics (day 43 = maintenance day 1). GLP-1 / "none" programs are always maintenance with the picker unlocked; the THINNR program locks the picker through day 42 for patients AND staff.
  **How to apply:** a provider restart inserts a new episode (nothing deleted); the patient row's start date mirrors it by trigger.
- **Safety blocks are re-evaluated at activation time, not at parking time.** Both provider-override steps re-read the patient's LATEST screening answers and the CURRENT library row before touching the block: a medication block parked after a pregnancy "no" becomes a pregnancy refusal once the patient answers "yes", and an unpublished diet cannot be activated through an override.
  **Why:** the block row's question list is a snapshot; a reviewer found an override could activate a now-pregnancy-blocked diet because the service only looked at the stale snapshot.
- **Pregnancy blocks have no provider override; medication / eating-disorder blocks do.** A pregnancy block still parks the pick (provider notified) but the provider can only reject it and point to the fertility plan.
- **Diet choice never touches targets.** Targets = pure Mifflin-St Jeor calculator in the lib with patient overrides merged last; the server writes a daily snapshot on read.
- **Parity proof pattern:** one fixture in the lib; the API vitest suite and the mobile parity script both run it. Mobile imports the lib only through one bridge module that adds the Approved Foods source for protocol-phase verdicts.
- **Push vendor boundary: outbox rows keep the specific kind, pushes do not.** Diet rows (staff and patient) keep kinds like severe-allergy / pregnancy-warning and event-level copy for the authenticated bell / in-app list; the message that leaves for Expo is rewritten by the sender to ONE generic non-clinical kind + generic copy + route/notification id (staff pushes carry no patient id). Tests assert the wire payload contains no diet / allergy / pregnancy wording.
  **Why:** "generic copy" alone was rejected in review — a clinical kind paired with a patient id is still identifiable health information at a vendor without a BAA.

# Staff-facing diet surfaces (roster, record, HQ library, reporting)

- **Roster diet facts are a nullable family with a real "no diet" inside it.** `diet: null` on the facts object = the patient chose nothing; the facts object itself missing = unknown. "% fits diet" = fits / (fits + does_not_fit) over the trailing window and is null (rendered "Unknown") whenever there is no diet or no verdict-bearing entries; 0% with a sample is a real figure. Web and mobile each carry a pure three-way display module pinned by a suite.
  **Why:** owner rule — unknown must never read as zero; a lazy `?? 0` on either client silently violates it.
- **Diet alerts carry no new table or seen-state.** The office alerts feed derives the last 7 days from existing diet rows (blocks, overrides, severe allergy entries, pregnancy conflicts) deduped per patient+kind; the digest only counts them; HQ sees them read-only.
  **How to apply:** add a new diet alert kind by extending the shared evaluator and the PHI-free copy map together; do not invent a per-kind outbox.
- **HQ Diet library gate = content permission (web 'knowledge' / server content_manage); reporting gate = analytics ('overview').** Entry edits are PUT with changed fields + expectedVersion (409 → toast + reload); publish / retire / unpublish ask twice. Drafts never reach patients because the patient routes read only published rows.
- **The catalog quotes no program documents.** The verbatim test pins that the only program wording the library reuses is the phase names; if a future entry quotes a program passage, add it to the archive-matched list in that test, never paraphrase.
- **Reporting rollup semantics:** standing counts (frameworks, phases, lists, pregnancy conflicts) are as-of-now, event counts (changes, blocks, overrides) are range-bounded; no activated patient in scope → `available:false` with null counts; RPC failure → 502, never zeros.
- **Mobile provider app is read-only for diet.** Row line + record card display only, with a footnote pointing writes at the web app; the record fetch reuses the roster facts shape (no second DTO).
- **A column added for a new fact must be proven through the RPC that writes it, on real PostgreSQL.** The per-entry fit verdict column shipped with the roster facts and the API sent it on every upsert, but the atomic diary RPC's `jsonb_to_recordset` did not read it — every verdict was dropped and the roster could never leave Unknown; every route fake stayed green.
  **How to apply:** when a feature adds a column that an existing RPC must persist, replace the RPC in the same migration (grants restated) and add an assertion to the real-PG suite that round-trips the new column; keep the suite under the feature's validation glob.
- **Reporting counts key on persisted enum values, not on labels the UI invents.** Diet changes group by the stored `selected_by_role` (`patient | staff | system`); "just tracking" is its own count, never folded into "on a diet"; whole-network figures use the same enabled-practice rule as the per-office route (otherwise the network total can exceed the sum of visible offices).

