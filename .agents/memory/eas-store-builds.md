---
name: EAS store builds for the patient app
description: Durable rules for keeping the Expo patient app store-buildable with EAS — what config resolution can and cannot prove, the Tap to Pay build flag, OTA publish guards, project-id bootstrap, and the store-link switch.
---

# EAS store builds

**Resolved config ≠ prebuilt native project.** `expo config` resolves plugins
but does not run their mods, so plugin-written permission strings and
entitlements are invisible there; assert plugin *options* for those and only
read infoPlist/entitlements for keys authored directly in the manifest.
Autolinked native packages add permissions even when unused — audit the
resolved config, and remove an unused native package rather than block it.

**Tap to Pay is a build-time decision, enforced twice.** The entitlement +
Terminal plugin exist only when the build flag is on (development profile),
because Apple must grant the entitlement before a submission may request it.
The JS side must gate on the same flag (exposed under `extra.thinnr`) — the
API saying "available" and the device being native is not enough, or a store
build stages a sale that cannot connect a reader. Prove both flag shapes.
**Why:** a flag-off store build has no entitlement or location permission to
fall back on.

**OTA updates inherit nothing from builds, and never check compatibility.**
Bare `eas update` applies neither the profile `env` block nor the EAS
environment, and publishes even when no build on the channel shares the
runtime fingerprint — it only warns, and no phone ever receives the fix.
Publishing goes through one wrapper that applies the profile env, verifies the
EAS environment, resolves the fingerprint under that env (the Tap to Pay flag
changes it) and requires a finished build with it on the channel. Verify CLI
flags against the installed `eas-cli`, not memory (subcommands differ).

**Project id is public and belongs in app.json.** `eas init --id` writes it
there; the env variable is only an override. A "no secrets committed" check
must therefore allow that one key and still forbid tokens, keys, workspace
hosts and hand-written update URLs.

**How to apply:** any new native dependency, permission string or manifest
change → re-run the store-config check; if the fingerprint changed, a store
build is required and the OTA wrapper will say so.

## Store link switch

The patient app link is resolved in one API module from the HQ store-link
setting (TestFlight / Play internal-testing URLs accepted) and falls back per
platform to the Expo Go page. Invite email, roster copy, practice QR codes and
launch readiness all read that resolver — never build the link per call site.
