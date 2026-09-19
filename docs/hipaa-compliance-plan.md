# THINNR HIPAA Compliance Plan

_Status: draft for review with counsel. Written September 19, 2026. Items marked **(verify)** were taken from vendor pages or secondary sources and need confirmation before money or contracts move._

This is the plan for taking THINNR from "an app that handles patient data carefully" to "a HIPAA-compliant business associate that can sign a BAA with a med spa and back it up." It is written in plain English first; legal citations are in the tables for counsel.

---

## 1. Where we stand and what changes

**Our role.** Each med spa is the covered entity. THINNR stores and processes patient data on the med spa's behalf, which makes THINNR a **business associate** (45 CFR 160.103). That means:

- We sign a Business Associate Agreement (BAA) with every office.
- We must meet the Security Rule directly (it applies to business associates).
- We must support the Privacy Rule rights the office owes its patients (access, amendment, accounting of disclosures) because the records live with us.
- Every vendor that touches patient data on our behalf is our **subcontractor** and must sign a BAA with us. No BAA, no PHI.

**Open question for counsel (before anything else):** whether a cash-pay med spa that never bills insurance is a HIPAA covered entity. Many are not, strictly. Our position should be to build to HIPAA regardless: offices will ask for it, state medical-privacy laws apply either way, and it costs less to do once.

**What already exists in the product** (verified in the codebase):

| Area | What we have today |
|---|---|
| Authentication | Supabase GoTrue; passwordless codes; SMS MFA for staff; forced sign-out ends sessions on every device; sign-in ledger |
| Authorization | Every office is a tenant; staff pinned to their own office; HQ needs explicit office + permission; RLS on Supabase tables; DB-only role allowlist |
| Audit trail | Append-only audit events for staff/HQ actions; 7-year detail, then monthly summaries forever; exportable |
| Patient rights | Patient self-service export (full ZIP of every data family plus media); deletion request with 7-day grace |
| Retention | Timed clean-up for coach transcripts (2y), notifications (180d), job logs, sign-ins, webhook payloads; photos, labs, weights, care-team messages never auto-deleted |
| Logging | Structured logs with secret redaction; request-latency metrics; data-growth snapshots |
| Storage hygiene | Path-owned media objects, signed URLs with short TTL, storage reconciliation job |
| Threat model | `threat_model.md` maintained in repo |

**What is missing**, grouped into the six workstreams below:

1. Hosting and vendors that will sign BAAs (the biggest cost and the longest lead time)
2. Retention, closure, export, and legal hold in the product
3. Security Rule safeguards we have not formalized (risk analysis, access reviews, encryption inventory, contingency plan)
4. Privacy Rule mechanics (BAA template, notice language, patient-rights procedures, accounting of disclosures)
5. Breach response
6. Policies, training, and the annual cycle

---

## 2. Workstream A: Hosting and vendors

Rule: **PHI may only sit in, or pass through, a system whose operator has signed a BAA with us.** Everything below is about making that true.

### A1. Vendor map

| Vendor | Touches PHI? | BAA available? | Decision |
|---|---|---|---|
| **Supabase** (database, auth, storage) | Yes, all of it | Yes: Team plan ($599/mo) + HIPAA add-on **(verify price)**; requires Small compute or larger and PITR | Sign. Move storage here or to S3 (see A2). |
| **Vercel** (API + web hosting) | Yes (requests carry PHI) | Yes: Pro + HIPAA add-on (~$350/mo) **(verify)**; Blob and AI Gateway not listed as covered **(verify)** | Sign, or move API to AWS (Fargate/Lambda). Cost is similar; Vercel is less migration work. |
| **Replit** (current dev hosting, object storage, AI proxy) | Yes today (media bytes, AI calls) | No | **Must leave before real PHI.** Media → Supabase Storage or S3. AI → direct provider under BAA. Dev environment must use synthetic data only. |
| **OpenAI** (coach, photo reads, label scan, support) | Yes (meal photos, chat with health content) | Yes, on request for API customers with zero-retention **(verify current terms)**; alternative Azure OpenAI (BAA under Microsoft Products terms) | Sign directly. Stop routing production through the Replit proxy. Confirm zero data retention is enabled. |
| **Twilio** (SMS codes, missed-dose texts) | Codes: no. Reminders: yes if they name a medication | Yes (Twilio is HIPAA-eligible for Verify/Messaging with BAA) | Sign. Keep reminder copy PHI-free anyway ("Time for your dose" not "Time for your semaglutide"). |
| **Resend** (email) | Yes (shipment emails, claim emails, staff digests naming patients) | No | **Replace** with Paubox, AWS SES under AWS BAA, or Mailgun with BAA **(verify each)**. Until then, strip PHI from every email template (names + product names + health terms). |
| **Expo push** (notifications) | Payload passes through Expo servers | No | Keep, but make every push payload PHI-free: generic title, no medication names, no weights, no patient names for staff alerts. The missed-dose push currently includes the medication name and must change. |
| **Stripe** (payments) | Names, addresses, purchases | No BAA; payment processing is exempt under 45 CFR 164.502(a)(1)(ii) / the "payment" exception | Keep. Never send clinical data in Stripe metadata or product descriptions (product names like "GLP-1 4-week" are fine; "for patient with diabetes" is not). |
| **WarehouseCraft / NovEx** (fulfillment) | Names, addresses, product ordered | Unknown **(verify: ask them)** | Ask for a BAA. If refused, counsel decides whether shipping a labelled product is a payment/operations disclosure (likely yes) and document that decision. |
| **FatSecret / Open Food Facts** (food data) | No (lookups are not tied to a patient) | N/A | Confirm no patient identifier is ever sent in queries. |
| **Sentry / analytics / any future SaaS** | Depends | Case by case | Rule stands: no BAA, no PHI. Scrub before send. |

### A2. Target production architecture

Two configurations were costed earlier; both are compliant. Pick one before signing anything.

- **Option 1: Vercel + Supabase + S3.** Vercel Pro + HIPAA add-on, Supabase Team + HIPAA add-on with PITR, media in Supabase Storage or S3 under AWS BAA, SES for email, OpenAI direct. ~ $1,450–1,650/mo at pilot scale. Least engineering work.
- **Option 2: AWS + Supabase.** API on Fargate or Lambda, web on Amplify or CloudFront+S3, media on S3, SES, Supabase as above. ~ $1,100–1,200/mo. More set-up work, cheaper long-run, everything under one AWS BAA.

Either way the checklist is the same:

1. Sign BAAs (Supabase, hosting, AWS if used, OpenAI, Twilio, email vendor). File the signed copies in the HQ file drive under a Compliance folder (6-year retention).
2. Move media bytes off Replit object storage to the chosen bucket; keep the same path-owned object model and signed-URL reads. Backfill, verify counts with the storage reconciliation job, then cut over.
3. Route all AI calls directly to the provider under BAA, with zero-retention confirmed. Keep the model-tier and usage-metering seams; only the transport changes.
4. Replace the email transport; keep the templates library as the single shell so PHI rules are enforced in one place.
5. Make production secrets live only in the production platform's secret store. Development never holds production database or storage credentials (this is already the practice; write it down as policy).
6. Enable PITR on Supabase; document backup schedule and tested restore procedure (Security Rule contingency plan).

### A3. Environments

- **Production:** real PHI, BAA-covered vendors only, access limited to named people with MFA.
- **Staging:** synthetic data only. Never restore a production backup into staging.
- **Development (Replit):** synthetic data only. The demo seed is the dataset. This is the current posture; it becomes a written rule.

---

## 3. Workstream B: Retention, closure, export, legal hold

This is the product engineering work. It was scoped as seven build tasks (drafts in `.local/tasks/`); the summary:

| # | Build task | Why it matters | Depends on |
|---|---|---|---|
| B1 | **Retention floors and clinical-record setting** — new "clinical record retention" policy (default 7 years, range 5–10), audit floor raised to 6 years, test proving care-team messages are never on the coach-transcript timer | HIPAA 6-year documentation rule; state 5–7 year medical record rules | — |
| B2 | **Legal hold** — per-patient and per-office hold flag; every retention job, purge, and offboarding step skips held rows; HQ list of holds; audit on set/clear | Deleting during a dispute or investigation is the worst outcome | B1 |
| B3 | **Account closure instead of purge** — "delete my account" destroys the login, devices, sessions, coach chats, and diary immediately; seals the clinical record (weights, meds, labs, photos, care-team messages, orders) read-only for the office until the clinical retention window passes; sealed rows excluded from claim/sign-up matching so a re-signup gets a fresh account; office sees an "Archived" filter | HIPAA has no right to erasure; today one tap deletes the office's medical record | B1, B2 |
| B4 | **Per-patient full record export for staff** — "Download full record" on the patient page: same archive the patient gets plus a printable PDF summary, no media cap (multi-part), works for sealed charts, every download audited | Right of access: office must produce a copy within 30 days | — |
| B5 | **Whole-office export** — HQ background job bundling every patient record and the office's business records; progress, multi-part download, audited | BAA termination ("return or destroy"), subpoenas, office switching vendors | B4 |
| B6 | **Office offboarding** — HQ flow: disable staff access, generate the B5 bundle, record the office's written choice (keep in cold storage vs destroy after hand-back), seal all charts with the retention clock, then destroy on schedule | Makes the BAA termination clause real | B3, B5 |
| B7 | **Edit history on the patient page** — confirm audit captures old and new values for every editable clinical field; show a History tab | Amendments must append, never overwrite (164.526) | B4 |

Optional B8: **cold archive export, off by default** — nightly compressed export of raw app events, audit detail, orders, payments, and shipments to a dedicated storage prefix partitioned by day, with an HQ toggle. Not required for compliance; it is cheap insurance for analytics and makes a future move of old raw data out of the live database trivial. See §8.

Retention rules the product will enforce once B1–B6 land:

| Data | Rule |
|---|---|
| Orders, payments, refunds, shipments, invoices, subscriptions | Never deleted (business and tax records) |
| Analytics rollups (no names) | Never deleted |
| Audit detail | 7 years, then monthly summaries forever (floor 6 years) |
| Clinical record of an open account | Kept indefinitely |
| Clinical record after closure or offboarding | Sealed; deleted when the clinical retention window (default 7 years) passes, unless on legal hold or the office chose cold storage |
| Coach transcripts, food diary | Coach timer as today (2 years, HQ-adjustable); purged at closure |
| Notifications, job logs, sign-ins, webhook payloads | Short timers as today |
| Compliance paperwork (BAAs, risk analyses, policies, training records) | 6 years minimum; HQ file drive Compliance folder, never deleted |

---

## 4. Workstream C: Security Rule safeguards

The Security Rule (45 CFR 164.308–.316) is a list of things you must have, most of which are documents and habits rather than code. Where the product already does the technical part, the work is writing it down and assigning an owner.

### C1. Administrative safeguards (164.308)

| Requirement | What we do |
|---|---|
| **Risk analysis** (required) | Write a formal risk analysis: every system that stores or moves PHI, the threats, the likelihood, the controls, the residual risk. Start from `threat_model.md`; add hosting, vendors, laptops, and people. Repeat annually and after major changes. |
| **Risk management** (required) | Track each identified risk to a decision: fix, accept (documented), or transfer. This plan is the first risk-management output. |
| **Sanction policy** | One paragraph: what happens to a staff member or contractor who violates the privacy/security policy. |
| **Information system activity review** | Monthly: someone reviews the audit-event export, failed sign-ins, forced sign-outs, storage reconciliation results, and system alerts. Record that the review happened. |
| **Security official** | Name one person (Andrew until there is someone else). Written. |
| **Workforce security / access management** | Named list of who has production access (Supabase dashboard, hosting, AWS, Stripe, email vendor). MFA on every account. Quarterly access review. Off-boarding checklist that removes access same day. |
| **Security awareness and training** | Annual training for everyone with access (a 30-minute recorded course + acknowledgement is enough). Keep the acknowledgements. |
| **Security incident procedures** | See Workstream E. |
| **Contingency plan** | Backup schedule (Supabase daily + PITR), a tested restore (do one, time it, write it down), an emergency-mode plan (who can act if the primary engineer is unreachable), and a criticality list (auth and patient data first, AI coach last). |
| **Evaluation** | Annual re-check of this plan. |
| **BAAs with subcontractors** | Workstream A. |

### C2. Physical safeguards (164.310)

Cloud vendors cover data-center controls under their BAA. Ours are about laptops and phones:

- Full-disk encryption and screen lock on every device that can reach production.
- No PHI in local files, screenshots, or chat tools. Support tickets reference patient IDs, not names.
- Device loss = incident (Workstream E).

### C3. Technical safeguards (164.312)

| Requirement | Status | Work |
|---|---|---|
| **Unique user identification** | Done: every staff member is their own login; shared office accounts do not exist | Policy: no credential sharing |
| **Emergency access** | Partial: HQ can reach any office with permission | Document the break-glass path and audit it |
| **Automatic logoff** | Partial: session lifetimes configured in Supabase | Set staff web session idle timeout (e.g., 15 min idle for HQ, 30 min for office desk); mobile stays signed in by design, protected by device lock |
| **Encryption at rest** | Done by vendor (Supabase, S3/GCS) | Write the encryption inventory: what is encrypted, by whom, key management |
| **Encryption in transit** | Done: TLS everywhere; HSTS | Confirm no plaintext internal hops in the chosen hosting |
| **Audit controls** | Done: append-only audit events; sign-in ledger; job runs | Add: read-access logging for patient records viewed by staff (today edits and exports are audited; views of a patient's chart should be too) |
| **Integrity** | Done: CAS on money transitions, append-only triggers, versioned edits | Document |
| **Person or entity authentication** | Done: passwordless codes + SMS MFA for staff; local JWT verification | Require MFA for all HQ and office-owner accounts (verify enforcement, not just availability) |
| **Transmission security** | Done: TLS, signed URLs with short TTL | Confirm media URLs never leak into logs or third-party analytics |

### C4. Application-level hardening to schedule

- **Minimum necessary in notifications and email:** PHI-free push and email bodies (ties to A1).
- **Read-access audit:** log staff views of patient detail, photos, labs, and conversations (not just edits), with the same 7-year retention. Needed for accounting and for breach investigation.
- **Session idle timeout on the operations web app.**
- **Export access logging:** already audited; keep it.
- **Security scan cadence:** run the dependency audit and static scan on every release; keep results 6 years (evidence for the evaluation requirement).

---

## 5. Workstream D: Privacy Rule mechanics

| Item | What we do |
|---|---|
| **BAA template** | Counsel drafts our standard BAA for offices (we are the BA) and our subcontractor BAA (for any small vendor without their own). Must cover: permitted uses, safeguards, subcontractors, patient-rights support, breach reporting timeline to the office, return/destroy or retain at termination, and the office's choice of cold storage. |
| **Right of access** (164.524) | Procedure: office receives request → staff uses "Download full record" (B4) → office delivers within 30 days, electronic form if requested. We publish a one-page how-to for offices. Fees: cost-based only. |
| **Amendment** (164.526) | Corrections append with history (B7). Denials are the office's call; our job is not to lose the original. |
| **Accounting of disclosures** (164.528) | Disclosures outside treatment/payment/operations are rare for us (subpoenas, law enforcement). Procedure: any such disclosure is recorded as an audit event with recipient and purpose; 6-year retention already exceeds the requirement. |
| **Minimum necessary** | Role model already limits staff to their office. Add: HQ drill-in into office data is logged and permission-gated (exists); AI prompts include only the fields needed for the answer (grounding compartments already do this). |
| **Patient-facing privacy notice** | The office owns the Notice of Privacy Practices. Our in-app consent screen should state plainly what THINNR stores, that the office is the record owner, retention after closure, and how to request a copy. |
| **De-identification for analytics** | HQ analytics and rollups are office-level counts with no identifiers; document that they meet the safe-harbor standard (164.514) so they can be kept forever and used for business reporting. |
| **Marketing** | No PHI-driven marketing without authorization. Product suggestions inside the app to an enrolled patient are treatment/operations; email campaigns to former patients are not. |

---

## 6. Workstream E: Breach response

Under the Breach Notification Rule (164.400–.414) we notify the office **without unreasonable delay and no later than 60 days** after discovery; the office notifies patients, HHS, and (for 500+) media. Our BAA will usually promise faster (commonly 5–10 business days).

Plan:

1. **Definition:** any unauthorized acquisition, access, use, or disclosure of PHI, including a lost device, a mis-sent email, a bug that showed one patient another's data, a vendor incident, or credentials leaked.
2. **Intake:** one email alias and one HQ contact. Anyone who suspects an incident reports within 24 hours.
3. **Triage within 48 hours:** what data, whose, how many, when, is it ongoing. Stop the bleeding (rotate keys, force sign-outs, disable accounts) using the existing controls.
4. **Risk assessment (164.402):** the four-factor test (nature of PHI, who received it, was it actually viewed, extent of mitigation). Document even when the conclusion is "low probability of compromise."
5. **Notify** the affected offices within the BAA window with what they need to notify patients: description, data types, dates, mitigation, contact.
6. **Log** every incident, including non-breaches, for 6 years.
7. **Test once a year** with a tabletop exercise.

Technical support that already exists: forced sign-out ends every device; sessions can be revoked; audit and sign-in ledgers show who touched what; storage reconciliation finds orphaned objects. Missing: staff read-access logging (C4), which is what turns "someone might have looked" into "these 14 charts were opened."

---

## 7. Workstream F: Policies, training, and the annual cycle

Documents to write (short; a page or two each):

1. Information Security Policy (roles, acceptable use, access control, MFA, devices)
2. Privacy Policy for workforce (minimum necessary, PHI handling, sanctions)
3. Risk Analysis and Risk Management Plan (living document)
4. Data Retention and Disposal Policy (the table in §3, plus how destruction is verified)
5. Incident Response Plan (§6)
6. Contingency / Disaster Recovery Plan (backups, restore test results, emergency mode)
7. Vendor Management Policy (BAA before PHI; annual review of each vendor's status)
8. Training record and acknowledgements

All live in the HQ file drive, Compliance folder, retained 6 years from last effective date. Every year: re-run the risk analysis, review access lists, re-train, run a restore test and an incident tabletop, re-check each vendor's BAA and HIPAA status pages, and update this plan.

---

## 8. Data growth, analytics, and the "second database" question

Sizing at 10,000 monthly active users after five years (assumptions generous): 1–3 TB of photos (≈ $20–65/mo), 200–400 GB of database (≈ $25–50/mo disk). Storage is not the scaling cost; AI and SMS are.

Reporting at scale is a speed problem, not a billing problem: Supabase charges a flat compute fee, not per query, so a 3-year scan costs nothing in dollars but slows the live app while it runs. The pattern that fixes it is already half in place:

1. **Rollups** (exists for app usage, audit, storage size): every HQ chart reads pre-computed daily totals, never raw history. Rule going forward: a report that needs raw rows gets a rollup first.
2. **Read replica** (later, ~1,000–5,000 users): Supabase read replicas give HQ reports their own copy so they cannot slow patients. Toggle: a second connection string for the reporting routes; no schema change.
3. **Cold archive** (optional now, useful at ~10k users): nightly export of old raw rows to compressed files in a storage bucket; a warehouse (BigQuery, DuckDB) answers deep-dive questions from there; the live database keeps ~90 days of raw events.

**Should we stand up a second database now?** No. A second Postgres for cold data would double the schema to maintain, need its own BAA-covered hosting, and buy nothing at current volume. The right "second store" for old data is files in a bucket, not a database, and B8 is that job. It toggles on and off with one HQ setting; with it off nothing changes. When it is on, it only ever *adds* files; it never removes anything from the live database. Moving raw rows *out* of the live database is a separate, later decision that this makes safe because the archive already exists.

---

## 9. Sequence and rough effort

| Phase | Work | Owner | Effort |
|---|---|---|---|
| **0. Decisions** | Covered-entity question; hosting option 1 vs 2; states served (retention window); AI transcripts and diary in/out of the record | Andrew + counsel | 1–2 weeks calendar |
| **1. Vendors** | Sign BAAs; order Supabase HIPAA add-on; move media off Replit; direct AI transport; email vendor swap; PHI-free push/email | Engineering + Andrew | 2–3 weeks engineering, vendor lead times in parallel |
| **2. Product (B1–B4)** | Floors, legal hold, account closure, per-patient export | Engineering (parallel task agents: B1→B2→B3 chain, B4 alongside) | ~2 weeks |
| **3. Product (B5–B7)** | Whole-office export, offboarding, edit history | Engineering | ~1–2 weeks |
| **4. Safeguards** | Read-access audit, idle timeout, MFA enforcement check, encryption inventory | Engineering | ~1 week |
| **5. Paper** | Risk analysis, policies, BAA template, incident plan, training | Andrew + counsel, engineering input | 2–3 weeks calendar |
| **6. Prove it** | Restore test, incident tabletop, access review, first monthly activity review | Everyone | 2 days |
| **Ongoing** | Annual cycle (§7); optional B8 archive when analytics needs it | | |

Realistic calendar: **8–10 weeks** to be able to sign a BAA in good faith, assuming vendor paperwork moves. Engineering total is roughly 6–8 weeks of work, much of it parallelizable.

---

## 10. Open decisions (need an answer before the relevant phase)

1. Are our offices HIPAA covered entities? (Build to HIPAA either way; affects contract wording.)
2. Hosting: Vercel + HIPAA add-on, or AWS?
3. Which states do offices operate in? Sets the default clinical retention (7 years covers TX, CA, NY; FL is 5).
4. Are AI coach transcripts and food diaries part of the medical record, or personal data purged at closure? (Plan assumes purged at closure.)
5. Default at office offboarding: cold storage retained by THINNR, or destroy after hand-back? (Plan recommends cold storage as default, destroy on request.)
6. WarehouseCraft / NovEx: will they sign a BAA?
7. Who is the named Security Official and who is the backup?
