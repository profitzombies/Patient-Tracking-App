---
name: Demo switch (published app has no demo)
description: How the guided demo is switched off in the published web and mobile apps while development keeps it, and the rules new screens must follow.
---

The user switched the guided demo off in the published app (Oct 2026) and wants the leftover demo code deleted in a LATER clean-up. One env var per environment, `THINNR_DEMO` (`on` in development, `off` in production), controls every demo ENTRY point on web and mobile. When it is unset, production builds fail closed and development builds keep the demo.

**Why:** development suites still exercise the demo, so it has to keep working there until the clean-up removes the demo code, seeds and demo-only tests. Deleting fake database rows is a separate task.

**Rules:**
- The switch decides only whether the demo can be ENTERED: personas, the guided demo, the signed-out provider dashboard and mobile claim-test. Whether demo labels, projections or seeded values appear is decided by the session. Signed-in screens never show them, whatever the switch says. Missing live data gets an honest empty or unavailable state, never Emma's numbers (see live-demo-ui-isolation.md).
- The web app clears a sessionStorage persona remembered from an earlier visit; it is never restored.
- Mobile hermetic suites that render screens without an account provider default to the demo account, so demo output is the suite baseline. Gate demo copy rather than deleting it, and keep the demo branch byte-identical so the existing demo checks stay valid.
- Public signed-out web pages that remain: training share link, /pay, cancel links, /security/report, /hq-setup, /claim-account. The admin course preview and the email studio route also stay reachable signed out (noted, not changed).

- Server AI routes follow the same rule: a signed-in patient is grounded on their own account, and a failed account load is an honest 502, never the demo patient. The menu and label scans used to ground every caller on the demo patient. Signed-out callers can still reach the coach and scans with demo grounding; closing that off is a separate decision.

**How to apply:** a new demo entry point must consult the switch. A new label or fallback must consult the session. A new signed-in screen or AI route must never use a seed module as a fallback.
