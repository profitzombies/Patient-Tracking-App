/**
 * Runs the held-request readiness protocol against an immutable historical
 * CoachChatContext source without changing the working tree.
 *
 * Example:
 * pnpm exec node scripts/verify-coach-readiness-baseline.mjs --baseline-ref c2a1caa3b16191d1aba39430f26660566d598a98
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const at = process.argv.indexOf('--baseline-ref');
const baselineRef =
  at >= 0 ? process.argv[at + 1] : process.argv.find(value => value.startsWith('--baseline-ref='))?.split('=')[1];
if (!baselineRef) throw new Error('Pass --baseline-ref <immutable git SHA>.');

const root = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), 'coach-readiness-baseline-'));
const contextPath = join(fixture, 'CoachChatContext.tsx');
const harnessPath = join(fixture, 'baseline.tsx');
try {
  writeFileSync(
    contextPath,
    execFileSync('git', ['show', `${baselineRef}:artifacts/thinnr-mobile/context/CoachChatContext.tsx`], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  writeFileSync(
    harnessPath,
    `import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { CoachChatProvider, useCoachChat } from ${JSON.stringify(contextPath)};
import { PatientAccountContext } from ${JSON.stringify(resolve(root, 'context/PatientAccountContext.tsx'))};
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ available: true }) });
let chat;
function Probe() { chat = useCoachChat(); return null; }
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function snapshot(id) { return { conversation: { id, title: id, titleState: 'ready', archivedAt: null, createdAt: '2025-01-01', updatedAt: '2025-01-01', version: 1, processingState: 'ready' }, messages: [], patient: { firstName: 'T', programDay: 1 }, nextBefore: null }; }
async function start(fn) { let value; await act(async () => { value = fn(); await Promise.resolve(); }); return { value }; }
async function main() {
const holds = []; let requests = 0;
const api = { fetchCoachConversation() { requests += 1; const held = gate(); holds.push(held); return held.promise; } };
const account = { resolving: false, account: { kind: 'real', patientId: 'baseline', api }, accountNotice: null, retryResolve() {}, getAccessToken: async () => 'token' };
await act(async () => { create(React.createElement(PatientAccountContext.Provider, { value: account }, React.createElement(CoachChatProvider, null, React.createElement(Probe)))); });
async function measure(action) { const began = Date.now(); const pending = (await start(action)).value; const before = requests; await new Promise(r => setTimeout(r, 12)); await act(async () => { holds.shift().resolve(snapshot('a')); await pending; }); return { requests: before, heldDelayMs: Date.now() - began }; }
const cold = await measure(() => chat.selectConversation('a'));
const beforeWarm = requests; const warm = await measure(() => chat.selectConversation('a')); warm.requests -= beforeWarm;
const beforeFocus = requests; const focus = await measure(() => chat.refreshThread()); focus.requests -= beforeFocus;
console.log(JSON.stringify({ baselineRef: ${JSON.stringify(baselineRef)}, protocol: 'held fetchCoachConversation + fixed 12ms release', cold, warm, focus }));
}
void main();
`,
  );
  execFileSync(
    'pnpm',
    ['exec', 'tsx', '--tsconfig', join(root, 'tsconfig.coach-readiness.json'), harnessPath],
    { cwd: root, stdio: 'inherit' },
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}