---
name: As-of-date billing state
description: How to decide whether a subscription/order counted on a past date in retention or trend SQL, and why current status columns lie about history.
---

**Rule:** when a report evaluates "was this patient subscribed / buying on date D" for several past dates, derive the answer from lifetime columns (`created_at <= D`, `canceled_at is null or > D`, `current_period_end` for lapsed-unpaid), never from today's `status`. Only exclude states that never became active (`incomplete`). Fully refunded orders drop out; partially refunded ones still count as buying — and the page copy, OpenAPI description and SQL header must all say the same thing.

**Why:** the first Patient retention RPC filtered `status in ('active','past_due')` before applying `canceled_at`, so a subscription canceled in August vanished from every earlier sample date and the trend understated past buying. The SQL test only covered the post-cancellation date, so it stayed green; code review caught it.

**How to apply:** any date-array RPC over billing rows needs a test with dates before, on, and after the cancellation / period-end boundary. On the server, treat a missing office×date row or a null count in the RPC payload as a 502 (shape error), not a zero — a renamed column must fail visibly.
