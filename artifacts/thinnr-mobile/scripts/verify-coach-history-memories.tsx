/**
 * Coach history + memory ownership/state check.
 *
 * This is intentionally a Node/react-test-renderer suite, not a Jest-shaped
 * smoke script. It uses the real two screens with narrowly scoped native/API
 * stubs and drives held promises to prove stale work cannot paint into a new
 * account or tab.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:coach-history-memories
 */
import React, { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import CoachHistoryScreen from "../app/coach-history";
import CoachMemoriesScreen from "../app/coach-memories";
import { apiState, type CoachMemory } from "./coach-history-memories-stubs/api-client";
import { coachState, type Conversation } from "./coach-history-memories-stubs/coach-chat";
import { patientAccount } from "./coach-history-memories-stubs/patient-account";
import { routerCalls } from "./coach-history-memories-stubs/router";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let checks = 0;
let failures = 0;
let finished = false;

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  }
}

function finish(): never {
  finished = true;
  if (failures) {
    console.error(`\n✗ coach history/memories check: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ coach history/memories check: ${checks} checks passed`);
  process.exit(0);
}

process.on("beforeExit", () => {
  if (!finished) {
    console.error("✗ coach history/memories check exited before completing");
    process.exit(1);
  }
});

type Node = {
  props: Record<string, unknown>;
  children: (Node | string)[];
  findAll(predicate: (node: Node) => boolean): Node[];
};

function byTestId(tree: ReactTestRenderer, id: string): Node | null {
  const nodes = (tree.root as unknown as Node).findAll(node => node.props.testID === id);
  // Stubbed primitives appear once as their function component and once as
  // their host node; both intentionally retain the same testID.
  assert(`renders ${id}`, nodes.length >= 1);
  return nodes.find(node => typeof node.props.onPress === "function") ?? nodes[0] ?? null;
}

function hasTestId(tree: ReactTestRenderer, id: string): boolean {
  return (tree.root as unknown as Node).findAll(node => node.props.testID === id).length > 0;
}

function includesText(tree: ReactTestRenderer, value: string): boolean {
  return (tree.root as unknown as Node).findAll(node =>
    node.children.some(child => child === value),
  ).length > 0;
}

function buttonByLabel(tree: ReactTestRenderer, label: string): Node | null {
  return (tree.root as unknown as Node).findAll(
    node => node.props.accessibilityLabel === label && typeof node.props.onPress === "function",
  )[0] ?? null;
}

function alertByTestId(tree: ReactTestRenderer, id: string): Node | null {
  return (tree.root as unknown as Node).findAll(
    node => node.props.testID === id && node.props.accessibilityRole === "alert",
  )[0] ?? null;
}

function buttonWithText(tree: ReactTestRenderer, text: string): Node | null {
  return (tree.root as unknown as Node).findAll(
    node => typeof node.props.onPress === "function" && node.findAll(child => child.children.some(grandchild => grandchild === text)).length > 0,
  )[0] ?? null;
}

async function tap(node: Node | null): Promise<void> {
  if (!node) return;
  await act(async () => {
    (node.props.onPress as (() => void) | undefined)?.();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function conversation(id: string, title = id): Conversation {
  return {
    id, title, updatedAt: "2025-01-01", processingState: "ready",
    createdAt: "2025-01-01", version: 1, titleState: "ready", archivedAt: null,
  };
}

function conversationPage(prefix: string, count: number): Conversation[] {
  return Array.from({ length: count }, (_, index) => conversation(`${prefix}-${index + 1}`));
}

function memory(id: string, state: CoachMemory["state"] = "active"): CoachMemory {
  return {
    id, text: `memory ${id}`, category: "General", state, version: 1, sensitivity: "ordinary",
    sourceConversationId: null, sourceMessageId: null, sourceCreatedAt: null,
    createdAt: "2025-01-01", updatedAt: "2025-01-01", confirmedAt: null,
  };
}

async function renderHistory(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(React.createElement(CoachHistoryScreen)); });
  return tree;
}

async function renderMemories(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(React.createElement(CoachMemoriesScreen)); });
  return tree;
}

async function update(tree: ReactTestRenderer, element: React.ReactElement): Promise<void> {
  await act(async () => { tree.update(element); });
}

async function main() {
  // ── History: active/archived request race and >20 page ───────────────────
  patientAccount.resolving = false;
  patientAccount.account = { kind: "real", patientId: "patient-a" };
  patientAccount.getAccessToken = async () => "token-a";
  const activeHeld = deferred<{ conversations: Conversation[]; nextOffset: number | null }>();
  const archivedHeld = deferred<{ conversations: Conversation[]; nextOffset: number | null }>();
  let historyCalls = 0;
  coachState.list = (archived, offset) => {
    historyCalls += 1;
    if (offset === 0) return archived ? archivedHeld.promise : activeHeld.promise;
    return Promise.resolve({ conversations: [conversation("conversation-21")], nextOffset: null });
  };
  const history = await renderHistory();
  assert("history renders an explicit loading state", hasTestId(history, "history-loading"));
  await tap(byTestId(history, "tab-archived"));
  await act(async () => { archivedHeld.resolve({ conversations: conversationPage("archived", 20), nextOffset: 20 }); await Promise.resolve(); });
  await act(async () => { activeHeld.resolve({ conversations: [conversation("active-stale")], nextOffset: null }); await Promise.resolve(); });
  await settle();
  assert("archived tab wins over late active request", includesText(history, "archived-1") && !includesText(history, "active-stale"));
  assert("history renders an explicit populated state", hasTestId(history, "history-list"));
  assert("history requested both tab pages", historyCalls === 2);
  await tap(byTestId(history, "history-load-more"));
  await settle();
  assert("history appends the 21st row after a 20-row first page", includesText(history, "conversation-21"));
  assert("history load-more keeps the beginning and end of its 20-row first page", includesText(history, "archived-1") && includesText(history, "archived-20"));

  // Pagination errors are visible/retryable rather than console-only.
  coachState.list = (_archived, offset) =>
    offset === 20 ? Promise.reject(new Error("network")) : Promise.resolve({ conversations: [conversation("archived-1")], nextOffset: 20 });
  await update(history, React.createElement(CoachHistoryScreen));
  await tap(byTestId(history, "history-load-more"));
  await settle();
  assert("history pagination failure is an accessible inline ErrorBox", alertByTestId(history, "history-load-more-error") !== null);
  assert("history pagination failure exposes retry", byTestId(history, "history-load-more-retry") !== null);

  // First-page failures stay visibly distinct from a successful empty result.
  await act(async () => { history.unmount(); });
  let retrySucceeds = false;
  coachState.list = async () => {
    if (!retrySucceeds) throw new Error("network");
    return { conversations: [], nextOffset: null };
  };
  const errorHistory = await renderHistory();
  await settle();
  assert("history first-page failure renders an explicit error state", hasTestId(errorHistory, "history-error-state"));
  assert("history first-page failure exposes Retry", byTestId(errorHistory, "history-retry") !== null);
  assert("history failure does not render a false empty state", !hasTestId(errorHistory, "history-empty-state"));
  retrySucceeds = true;
  await tap(byTestId(errorHistory, "history-retry"));
  await settle();
  assert("successful retry can transition to the empty state", hasTestId(errorHistory, "history-empty-state"));
  await act(async () => { errorHistory.unmount(); });

  // Empty active/archived states have distinct copy and their actions use the
  // same new-chat and tab behavior as the header controls.
  coachState.list = async () => ({ conversations: [], nextOffset: null });
  routerCalls.length = 0;
  const emptyHistory = await renderHistory();
  await settle();
  assert("active empty state explains that there are no chats yet", includesText(emptyHistory, "No active conversations yet"));
  assert("active empty state offers a prominent new-conversation action", byTestId(emptyHistory, "history-empty-new-chat") !== null);
  assert("header keeps an accessible new-chat action", byTestId(emptyHistory, "history-new-chat") !== null);
  await tap(byTestId(emptyHistory, "history-new-chat"));
  assert("header new-chat action uses the real chat route", routerCalls.includes("push:/coach-chat"));
  await tap(byTestId(emptyHistory, "history-memories"));
  assert("memories row keeps its real route", routerCalls.includes("push:/coach-memories"));
  await tap(byTestId(emptyHistory, "history-empty-new-chat"));
  assert("empty-state new conversation uses the real chat route", routerCalls.includes("push:/coach-chat"));
  await tap(byTestId(emptyHistory, "tab-archived"));
  await settle();
  assert("archived empty state uses archive-specific copy", includesText(emptyHistory, "No archived conversations"));
  assert("archived empty state offers a way back to active chats", byTestId(emptyHistory, "history-view-active") !== null);
  assert("archived empty state also keeps new conversation available", byTestId(emptyHistory, "history-empty-new-chat") !== null);
  await tap(byTestId(emptyHistory, "history-view-active"));
  await settle();
  assert("archived empty state can return to active history", includesText(emptyHistory, "No active conversations yet"));
  await act(async () => { emptyHistory.unmount(); });

  // ── Memories: demo must never invoke a generated read/write ───────────────
  let memoryReads = 0;
  let memoryWrites = 0;
  apiState.list = async () => {
    memoryReads += 1;
    return { memories: [memory("should-not-load")], nextOffset: null };
  };
  apiState.update = async () => {
    memoryWrites += 1;
    return { memory: memory("unexpected") };
  };
  patientAccount.account = { kind: "demo" };
  patientAccount.getAccessToken = undefined;
  const memories = await renderMemories();
  await settle();
  assert("demo does not issue memory reads", memoryReads === 0);
  assert("demo does not issue memory writes", memoryWrites === 0);

  // A held patient-A read may not paint after the renderer switches identity;
  // keying also clears the in-progress editor synchronously.
  const patientARead = deferred<{ memories: CoachMemory[]; nextOffset: number | null }>();
  const patientBRead = deferred<{ memories: CoachMemory[]; nextOffset: number | null }>();
  apiState.list = ({ offset }) => {
    memoryReads += 1;
    if (offset === 0 && patientAccount.account.kind === "real" && patientAccount.account.patientId === "patient-a") return patientARead.promise;
    return patientBRead.promise;
  };
  patientAccount.account = { kind: "real", patientId: "patient-a" };
  patientAccount.getAccessToken = async () => "token-a";
  await update(memories, React.createElement(CoachMemoriesScreen));
  await act(async () => { patientARead.resolve({ memories: [memory("a-edit")], nextOffset: null }); await Promise.resolve(); });
  await settle();
  const editButton = buttonByLabel(memories, "Edit memory");
  await tap(editButton);
  assert("patient A can open its editor", (memories.root as unknown as Node).findAll(node => node.props.value === "memory a-edit").length >= 1);
  patientAccount.account = { kind: "real", patientId: "patient-b" };
  patientAccount.getAccessToken = async () => "token-b";
  await update(memories, React.createElement(CoachMemoriesScreen));
  assert("account switch clears prior editor immediately", (memories.root as unknown as Node).findAll(node => node.props.value === "memory a-edit").length === 0);
  await act(async () => { patientBRead.resolve({ memories: [memory("b-only")], nextOffset: null }); await Promise.resolve(); });
  await settle();
  assert("account switch shows only new patient rows", includesText(memories, "memory b-only") && !includesText(memories, "memory a-edit"));

  // A correction returns a replacement ID; the original id must disappear.
  apiState.update = async (id, data, options) => {
    memoryWrites += 1;
    assert("memory mutation uses captured account token", options?.headers?.Authorization === "Bearer token-b");
    assert("correction targets old memory id", id === "b-only" && data.action === "correct");
    return { memory: { ...memory("replacement-id"), text: "corrected fact" } };
  };
  const bEdit = buttonByLabel(memories, "Edit memory");
  await tap(bEdit);
  const input = (memories.root as unknown as Node).findAll(node => node.props.value === "memory b-only")[0] ?? null;
  await act(async () => { (input?.props.onChangeText as ((text: string) => void) | undefined)?.("corrected fact"); });
  const save = buttonWithText(memories, "Save");
  await tap(save);
  await settle();
  assert("correction replaces old card when API supplies new id", includesText(memories, "corrected fact") && !includesText(memories, "memory b-only"));
  assert("correction performed exactly one real write", memoryWrites === 1);

  // Failed mutations and failed pagination render visible, accessible state.
  apiState.update = async () => { throw new Error("network"); };
  const forget = buttonByLabel(memories, "Forget memory");
  await tap(forget);
  await settle();
  assert("failed memory mutation is visible", alertByTestId(memories, "memories-action-error") !== null);

  apiState.list = ({ offset }) => offset === 20
    ? Promise.reject(new Error("network"))
    : Promise.resolve({ memories: [memory("replacement-id")], nextOffset: 20 });
  patientAccount.account = { kind: "real", patientId: "patient-c" };
  patientAccount.getAccessToken = async () => "token-c";
  await update(memories, React.createElement(CoachMemoriesScreen));
  await settle();
  await tap(byTestId(memories, "memories-load-more"));
  await settle();
  assert("memory pagination failure is visible", alertByTestId(memories, "memories-load-more-error") !== null);
  assert("memory pagination failure has retry", byTestId(memories, "memories-load-more-retry") !== null);

  // The server pages all states together. A selected tab must keep its
  // paginator mounted when its first 20 rows happen to belong to other tabs,
  // otherwise an older matching row is permanently unreachable.
  const filteredCases: Array<{
    tabId: string;
    firstState: CoachMemory["state"];
    olderState: CoachMemory["state"];
    emptyHeading: string;
    olderId: string;
  }> = [
    { tabId: "tab-active", firstState: "removed", olderState: "active", emptyHeading: "No Active Memories", olderId: "older-active" },
    { tabId: "tab-pending", firstState: "active", olderState: "pending", emptyHeading: "All Caught Up", olderId: "older-pending" },
    { tabId: "tab-removed", firstState: "active", olderState: "removed", emptyHeading: "No Removed Memories", olderId: "older-removed" },
  ];
  for (const [index, filteredCase] of filteredCases.entries()) {
    patientAccount.account = { kind: "real", patientId: `mixed-${index}` };
    patientAccount.getAccessToken = async () => `token-mixed-${index}`;
    apiState.list = ({ offset }) => Promise.resolve(
      offset === 20
        ? { memories: [memory(filteredCase.olderId, filteredCase.olderState)], nextOffset: null }
        : { memories: Array.from({ length: 20 }, (_, row) => memory(`newer-${index}-${row}`, filteredCase.firstState)), nextOffset: 20 },
    );
    const filtered = await renderMemories();
    await settle();
    if (filteredCase.tabId !== "tab-active") await tap(byTestId(filtered, filteredCase.tabId));
    assert(`${filteredCase.tabId} does not show a false exhausted empty state`, !includesText(filtered, filteredCase.emptyHeading));
    assert(`${filteredCase.tabId} explains that another page can contain matches`, byTestId(filtered, "memories-check-more") !== null);
    await tap(byTestId(filtered, "memories-load-more"));
    await settle();
    assert(`${filteredCase.tabId} reaches its older matching memory`, includesText(filtered, `memory ${filteredCase.olderId}`));
    await act(async () => { filtered.unmount(); });
  }

  await act(async () => { memories.unmount(); });
  finish();
}

void main().catch(error => {
  console.error("✗ coach history/memories check crashed", error);
  process.exit(1);
});