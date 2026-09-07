---
name: Staff inbox over patient chat threads
description: Durable rules for the office conversation inbox (workflow state, staff replies into patient threads, coach exclusion, audit) built on the persisted patient_chat tables.
---

# Staff inbox over patient chat threads

- **Workflow state is derived by a DB trigger, not by the API.** An AFTER INSERT trigger on chat messages moves a conversation open (patient turn) / waiting_patient (staff turn) and accumulates response-time totals. **Why:** the patient app persists rows through `ON CONFLICT ... DO UPDATE` upserts and re-upserts finalized rows (card/hidden flips); a row-exists upsert does not fire the INSERT trigger, so replays can't corrupt state, and the API never has to sequence two writes. **How to apply:** new status transitions from message traffic belong in the trigger; only explicit staff actions (assign/close/reopen) go through the API, and closing never blocks a patient turn from reopening.
- **Staff rows are server-owned.** Clients render `role: "staff"` rows (with `senderLabel`) but must never persist or append them; the patient-chat POST rejects them and the mobile persistence loops skip them. Delivery is a refresh (focus / foreground / `care_team_reply` push data) that merges only unseen ids — first load prepends, later refreshes append.
- **The coach never answers staff.** Coach/support routes fold `staff` history turns into a context-only user-role note (adjacent ones merge) right after zod parsing; the raw last turn must still be `user` (400 otherwise). Any new AI surface that replays chat history must reuse that fold.
- **Read audit rides the newest transcript page.** Reading events without a `before` cursor upserts the per-staff read marker and writes the audit row; older-page loads don't. Audit metadata never carries message/note text.
- **Coach route tests share one per-process burst bucket.** The existing coach suite already spends the full per-IP burst, so extra requests added to the same process flake later tests with 429; isolate new request-making tests in their own module.
- **Auto-close is a read-time overlay, not a write.** HQ's conversation auto-close window is passed to the inbox RPCs as a cutoff instant; idle threads read as closed (`autoClosed`) while persisted status stays untouched, so policy changes reclassify instantly and a patient message reopens for free. An explicit staff status change bumps `updated_at` so a deliberate reopen holds.
- Metrics RPC with `null` provider = all non-disabled offices; the HQ overview and office overview both fail the whole overview (502) when the inbox RPC is down rather than showing zeros.
