---
name: Scoped <style> font reset trap
description: Why single-class font-size rules silently lose inside mockup components that reset button/input fonts with a scoped selector.
---

Rule: in a component-scoped `<style>` block, never write `.root button,.root input{font:inherit}`. Use `font-family:inherit` (or rely on Tailwind preflight, which already sets `font: inherit` at element specificity).

**Why:** `.root button` is specificity 0,1,1 and beats any single-class rule like `.field-link{font-size:10px}` (0,1,0), so links/buttons render at the inherited 16px. The CSS looks correct, tsc is green, and the bug only shows visually ("Forgot password looks too large"). Nine parallel design subagents all copied the trap from the winner file.

**How to apply:** when a class font-size does nothing on a button/input in a mockup, grep the file for `{font:inherit}` before touching sizes. Related: Tailwind preflight makes inline SVGs block-level, so icon-in-text buttons need `display:inline-flex`. Also: right after adding new mockup files, subagents often report blank captures — restart the sandbox and verify yourself rather than trusting their screenshots.
