---
name: Expo persona gate blocks direct screenshots
description: How to visually verify patient/staff screens in the THINNR Expo web app given the persona chooser gate.
---

Deep links to patient (or staff) routes on Expo web bounce to the persona chooser until a persona is selected in that browser session, so one-shot screenshot tools land on "CHOOSE YOUR EXPERIENCE" instead of the target screen.

**Why:** The app gates its route groups behind a persona/sign-in flow with per-session state; a fresh headless browser has no persona set.

**How to apply:** For any on-screen verification past the gate, drive a testing subagent (choose Patient → Enter, then navigate tabs) instead of screenshotting the route directly. Tell it the exact expo.kirk.replit.dev URL and to confirm the domain. Note: the demo sign-in's password field is not wrapped in a form (browser logs a DOM warning) — pre-existing, not a regression signal.
