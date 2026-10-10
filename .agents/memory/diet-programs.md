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
