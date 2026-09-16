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
  const historyLoading = byTestId(history, "history-loading");
  assert(
    "history loading state announces its progress accessibly",
    historyLoading?.props.accessibilityRole === "progressbar"
      && historyLoading.props.accessibilityLabel === "Loading chat history"
      && historyLoading.props.accessibilityLiveRegion === "polite"
      && historyLoading.props["aria-busy"] === true
      && historyLoading.props["aria-live"] === "polite",
  );
  const historySkeleton = byTestId(history, "history-skeleton");
  assert(
    "history skeleton is made of non-interactive conversation rows",
    (historySkeleton?.findAll(node => typeof node.props.onPress === "function").length ?? 0) === 0
      && (history.root as unknown as Node).findAll(node => node.props.testID === "history-skeleton-row").length >= 3,
  );
  assert(
    "history skeleton includes title and date placeholders",
    (history.root as unknown as Node).findAll(node => node.props.testID === "history-skeleton-title").length >= 3
      && (history.root as unknown as Node).findAll(node => node.props.testID === "history-skeleton-date").length >= 3,
  );
  await tap(byTestId(history, "tab-archived"));
  await act(async () => { archivedHeld.resolve({ conversations: conversationPage("archived", 20), nextOffset: 20 }); await Promise.resolve(); });
  await act(async () => { activeHeld.resolve({ conversations: [conversation("active-stale")], nextOffset: null }); await Promise.resolve(); });
  await settle();
  assert("archived tab wins over late active request", includesText(history, "archived-1") && !includesText(history, "active-stale"));
  assert("history renders an explicit populated state", hasTestId(history, "history-list"));
  assert("history requested both tab pages", historyCalls === 2);
  const openHeld = deferred<void>();
  let selectedId: string | null = null;
  coachState.select = id => { selectedId = id; return openHeld.promise; };
  routerCalls.length = 0;
  const navigationStarted = performance.now();
  await tap(buttonByLabel(history, "Open conversation: archived-1"));
  const navigationElapsed = performance.now() - navigationStarted;
  assert("selection establishes the requested conversation immediately", selectedId === "archived-1");
  assert("history opens destination before held transcript completes", routerCalls.includes("push:/coach-chat"));
  console.log(`synthetic history tap→destination dispatch=${navigationElapsed.toFixed(2)}ms; transcript still held`);
  await act(async () => { openHeld.resolve(); });
  await tap(byTestId(history, "history-load-more"));
  await settle();
  assert("history appends the 21st row after a 20-row first page", includesText(history, "conversation-21"));
  assert("history load-more keeps the beginning and end of its 20-row first page", includesText(history, "archived-1") && includesText(history, "archived-20"));

  // A same-tab refresh keeps already loaded rows usable while its first page
  // is held. The skeleton is only for the initial empty page.
  const refreshHeld = deferred<{ conversations: Conversation[]; nextOffset: number | null }>();
  coachState.list = (_archived, offset) => offset === 0
    ? refreshHeld.promise
    : Promise.resolve({ conversations: [], nextOffset: null });
  await update(history, React.createElement(CoachHistoryScreen));
  assert("history keeps existing rows visible during incremental refresh", hasTestId(history, "history-list") && !hasTestId(history, "history-loading"));
  assert("history rows remain usable during incremental refresh", buttonByLabel(history, "Open conversation: archived-1") !== null);
  await act(async () => { refreshHeld.resolve({ conversations: conversationPage("refreshed", 2), nextOffset: null }); await Promise.resolve(); });
  await settle();

  // A retryable background failure must not remove already-visible rows.
  coachState.list = async () => { throw new Error("offline"); };
  await update(history, React.createElement(CoachHistoryScreen));
  assert("refresh failure retains populated history", includesText(history, "refreshed-1") && hasTestId(history, "history-list"));
  assert("stale history explicitly offers retry", hasTestId(history, "history-refresh-retry"));
  assert("stale failure is neither skeleton nor empty", !hasTestId(history, "history-loading") && !hasTestId(history, "history-empty-state"));

  // Pagination errors are visible/retryable rather than console-only.
  coachState.list = (_archived, offset) =>
    offset === 20 ? Promise.reject(new Error("network")) : Promise.resolve({ conversations: [conversation("archived-1")], nextOffset: 20 });
  await update(history, React.createElement(CoachHistoryScreen));
  await tap(byTestId(history, "history-load-more"));
  await settle();
  assert("history pagination failure is an accessible inline ErrorBox", alertByTestId(history, "history-load-more-error") !== null);
  assert("history pagination failure exposes retry", byTestId(history, "history-load-more-retry") !== null);

  // Archive and restore remain row actions, with the selected tab captured at
  // the time of the request.
  const archiveCalls: Array<{ id: string; archived: boolean }> = [];
  coachState.archive = async (item, archived) => {
    archiveCalls.push({ id: item.id, archived });
  };
  await tap(byTestId(history, "tab-archived"));
  await settle();
  await tap(buttonByLabel(history, "Restore conversation"));
  assert("history still restores an archived conversation", archiveCalls[0]?.id === "archived-1" && archiveCalls[0]?.archived === false);
  coachState.list = (archived, offset) => offset === 0
    ? Promise.resolve({ conversations: [conversation(archived ? "archived-1" : "active-stale")], nextOffset: null })
    : Promise.resolve({ conversations: [], nextOffset: null });
  await tap(byTestId(history, "tab-active"));
  await settle();
  await tap(buttonByLabel(history, "Archive conversation"));
  assert("history still archives an active conversation", archiveCalls[1]?.id === "active-stale" && archiveCalls[1]?.archived === true);

  // ── History: inline rename ───────────────────────────────────────────────
  coachState.list = (_archived, offset) => offset === 0
    ? Promise.resolve({ conversations: [conversation("named-1", "Chipotle dinner plan")], nextOffset: null })
    : Promise.resolve({ conversations: [], nextOffset: null });
  const renameCalls: Array<{ id: string; title: string }> = [];
  let renameFails = false;
  coachState.rename = async (row, title) => {
    renameCalls.push({ id: row.id, title });
    if (renameFails) throw Object.assign(new Error("This conversation changed. Refresh and try again."), { status: 409 });
    return { ...row, title, version: row.version + 1 };
  };
  await tap(byTestId(history, "tab-archived"));
  await settle();
  await tap(byTestId(history, "tab-active"));
  await settle();
  assert("history shows the server-written title", includesText(history, "Chipotle dinner plan"));
  await tap(buttonByLabel(history, "Rename conversation: Chipotle dinner plan"));
  const renameInput = byTestId(history, "rename-input-named-1");
  assert("rename opens an editor pre-filled with the current name", renameInput?.props.value === "Chipotle dinner plan"
    && renameInput?.props.maxLength === 40 && renameInput?.props.accessibilityLabel === "Conversation name");
  assert("the row's open button hides while its name is being edited", buttonByLabel(history, "Open conversation: Chipotle dinner plan") === null);
  await act(async () => { renameInput?.props.onChangeText("   "); });
  await tap(byTestId(history, "rename-save-named-1"));
  assert("an empty name is refused locally without a request", renameCalls.length === 0 && includesText(history, "Give it a name of 1 to 40 characters."));
  await act(async () => { renameInput?.props.onChangeText("  Burrito -- night!  "); });
  await tap(byTestId(history, "rename-save-named-1"));
  await settle();
  assert("save sends the cleaned name", renameCalls[0]?.id === "named-1" && renameCalls[0]?.title === "Burrito night");
  assert("the row shows the new name and closes the editor",
    includesText(history, "Burrito night") && !hasTestId(history, "rename-input-named-1")
    && buttonByLabel(history, "Open conversation: Burrito night") !== null);
  renameFails = true;
  await tap(buttonByLabel(history, "Rename conversation: Burrito night"));
  const retryInput = byTestId(history, "rename-input-named-1");
  await act(async () => { retryInput?.props.onChangeText("Taco night"); });
  await tap(byTestId(history, "rename-save-named-1"));
  await settle();
  assert("a version conflict keeps the editor open with the server message",
    hasTestId(history, "rename-input-named-1") && includesText(history, "This conversation changed. Refresh and try again."));
  await tap(byTestId(history, "rename-cancel-named-1"));
  assert("cancel closes the editor without renaming", !hasTestId(history, "rename-input-named-1") && renameCalls.length === 2);
  renameFails = false;

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
  const newChatCalls: string[] = [];
  coachState.start = () => {
    newChatCalls.push("start");
  };
  const emptyHistory = await renderHistory();
  await settle();
  assert("active empty state explains that there are no chats yet", includesText(emptyHistory, "No active conversations yet"));
  assert("active empty state offers a prominent new-conversation action", byTestId(emptyHistory, "history-empty-new-chat") !== null);
  assert("header keeps an accessible new-chat action", byTestId(emptyHistory, "history-new-chat") !== null);
  await tap(byTestId(emptyHistory, "history-new-chat"));
  assert("header new-chat action uses the real chat route", routerCalls.includes("push:/coach-chat"));
  assert("new-chat starts the conversation before routing", newChatCalls[0] === "start");
  await tap(byTestId(emptyHistory, "history-memories"));
  assert("memories row keeps its real route", routerCalls.includes("push:/coach-memories"));
  await tap(byTestId(emptyHistory, "history-empty-new-chat"));
  assert("empty-state new conversation uses the real chat route", routerCalls.includes("push:/coach-chat"));
  assert("empty-state new-chat also starts a conversation", newChatCalls[1] === "start");
  await tap(byTestId(emptyHistory, "tab-archived"));
  await settle();
  assert("archived empty state uses archive-specific copy", includesText(emptyHistory, "No archived conversations"));
  assert("archived empty state offers a way back to active chats", byTestId(emptyHistory, "history-view-active") !== null);
  assert("archived empty state also keeps new conversation available", byTestId(emptyHistory, "history-empty-new-chat") !== null);
  await tap(byTestId(emptyHistory, "history-view-active"));
  await settle();
  assert("archived empty state can return to active history", includesText(emptyHistory, "No active conversations yet"));
  await act(async () => { emptyHistory.unmount(); });
  coachState.start = () => {};

  // Account cache is only used as a synchronous initial value; successful
  // empty pages count as known data and do not flash a skeleton on refresh.
  coachState.cached = () => ({ conversations: [conversation("cached-a")], nextOffset: 20 });
  const cachedRefresh = deferred<{ conversations: Conversation[]; nextOffset: number | null }>();
  coachState.list = () => cachedRefresh.promise;
  const warmHistory = await renderHistory();
  assert("warm mount paints cached row while network held", includesText(warmHistory, "cached-a"));
  assert("warm mount has no initial skeleton", !hasTestId(warmHistory, "history-loading"));
  await act(async () => { cachedRefresh.reject(Object.assign(new Error("denied"), { status: 403 })); });
  assert("denied history removes cached rows", !includesText(warmHistory, "cached-a") && hasTestId(warmHistory, "history-error-state"));
  await act(async () => { warmHistory.unmount(); });
  const revokedPage = deferred<{ conversations: Conversation[]; nextOffset: number | null }>();
  coachState.list = () => revokedPage.promise;
  const revokedHistory = await renderHistory();
  coachState.accessDeniedError = "Your account access is unavailable. Retry to continue.";
  await act(async () => { revokedHistory.update(<CoachHistoryScreen />); });
  assert("revocation from another Coach operation immediately hides local cached rows", !includesText(revokedHistory, "cached-a") && hasTestId(revokedHistory, "history-error-state"));
  await act(async () => { revokedPage.resolve({ conversations: [conversation("late-private-page")], nextOffset: null }); });
  assert("held history success after shared revocation cannot paint private rows", !includesText(revokedHistory, "late-private-page") && !includesText(revokedHistory, "cached-a"));
  await act(async () => { revokedHistory.unmount(); });
  coachState.accessDeniedError = null;
  coachState.cached = () => ({ conversations: [], nextOffset: null });
  const emptyRefresh = deferred<{ conversations: Conversation[]; nextOffset: number | null }>();
  coachState.list = () => emptyRefresh.promise;
  const knownEmptyHistory = await renderHistory();
  assert("known-empty warm mount does not flash skeleton", hasTestId(knownEmptyHistory, "history-empty-state") && !hasTestId(knownEmptyHistory, "history-loading"));
  await act(async () => { emptyRefresh.resolve({ conversations: [], nextOffset: null }); knownEmptyHistory.unmount(); });
  coachState.cached = () => undefined;

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