---
name: Setup action working states
description: How practice-setup buttons show progress and how RTR suites must find them now that labels sit inside BusyLabel.
---

Setup buttons (plan, terms, cards, bank, finish, restart, pay) wrap their wording in the shared BusyLabel and guard double presses with a ref lock, not just `disabled` (two onClick calls in one act both run before a re-render).

**Why:** a props-text lookup (`text(button.props.children) === 'Finish setup'`) returns '' once the label is a BusyLabel element, so old RTR suites silently lose their buttons.

**How to apply:** in react-test-renderer suites read wording from the rendered instance tree (`text(button.children)`, whitespace-collapsed) or use testids; to see a working state, hold the fetch stub open on a promise and assert `data-busy="true"` before releasing. Finish setup is gated by one shared missing-items list that must mirror the server's completion checks (Stripe pending counts as done).
