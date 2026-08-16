# RFC: Parallel Pi Context Offloading Through Herdr

**Status:** Ready for task breakdown  
**Effort:** XL; approximately 4–7 focused engineering days  
**Target:** Expert pilot

## Problem and decision

Long-running Pi sessions spend context on repository exploration, independent analysis, and implementation details. Manually creating Herdr panes, starting fresh Pi sessions, prompting them, and collecting their answers is tedious.

Build one Pi tool, `spawn_pi`, that offloads a batch of independent tasks into fresh, visible Child Pis. Each child receives one task, works in the Parent Pi's current checkout with normal coding tools, and returns a concise attributed answer plus a resumable Pi session ID. Tasks run concurrently, and partial failures preserve successful results.

A child whose result is collected successfully is closed after its session ID is recorded. A failed, blocked, interrupted, or unattributable child remains visible for inspection.

This is an expert pilot. Concurrent children may edit the same checkout; the extension does not isolate, coordinate, or reconcile their changes.

## Scope and invariants

- A batch contains 1–4 independent tasks. The fixed limit avoids scheduling and uncontrolled terminal growth.
- Every task gets a fresh Pi session, fresh context window, and exactly one orchestrated prompt.
- `tab` is the default placement; a task may request `split`.
- Children run concurrently in the Parent Pi's current Herdr workspace, working directory, and checkout without stealing focus.
- Children receive normal Pi coding tools, including shell and file editing, but cannot invoke `spawn_pi`.
- The Parent Pi's model and thinking level are inherited when Pi requires them explicitly.
- The parent conversation is not copied into a child; only the bounded task envelope is sent.
- Results come from marked child Pi session entries. Terminal output is not an attributed result.
- The extension closes only resources created by the current call and still occupied by the expected child.
- Closing a pane does not delete its Pi session; users can resume it by returned session ID.
- The batch exists only for the current tool call. The extension does not persist or recover orchestration state, manage completed runtimes, or detach batches for background collection. It retains only current-parent-session child identities to close still-open panes during Parent session shutdown.

## Batch contract

1. Validate the complete request before creating Herdr resources.
2. Start all accepted tasks concurrently and preserve request order in the aggregate result.
3. Wait for each child to succeed, fail, or become blocked.
4. Preserve each task's outcome when another task fails.
5. Close a child only after collecting its attributed answer and session ID.
6. Leave blocked, failed, aborted, and unattributable children visible, returning their Herdr location and session ID when known.

If the Parent Pi aborts the tool call, stop waiting without interrupting or closing uncollected children. The runner classifies known unfinished children as `parent_aborted` when it can return an aggregate result; regardless of tool-framework result delivery, leaving those children open is guaranteed while the Parent session remains active. On Parent session shutdown for exit, new, resume, or fork, the extension closes still-open child panes it created after occupant verification; `/reload` leaves them open.

For batches with multiple tasks, the result includes a fixed warning that concurrent children share one checkout. Edits can overwrite or invalidate each other, children can observe changing files, and tests or Git operations can interfere. The extension performs no locking, write detection, reconciliation, or rollback.

## Prompt and result contract

Each child prompt begins with a unique marker:

```md
<!-- pi-herdr-task:<task-id> -->

You are a fresh Pi instance handling one bounded task for a Parent Pi.

Task: <task prompt>

Work directly in the current checkout. Other Pi instances may be working concurrently. Return a concise final answer containing:

- what you found or changed;
- verification performed;
- unresolved issues or interference observed.
```

For each child, the extension:

1. Assigns a deterministic Pi session ID before startup.
2. Records the child session path and pre-prompt latest entry when available.
3. Submits the marked prompt through Herdr.
4. Uses Herdr settlement only as the signal to inspect the Pi session.
5. Finds the user entry containing the exact task marker and selects its final descendant assistant response.
6. Caps the returned summary at 20,000 characters and reports truncation.

An attributed final answer is task success; Herdr lifecycle state alone is not. Startup or prompt errors are `failed`. A missing session, marker, valid ancestry, or final assistant response is `unattributable`. Manual user input after dispatch also makes the result `unattributable`. In both cases, preserve the child for inspection rather than guessing or scraping terminal output.

Return the session ID before closing a successful child. Users can later resume it with `/resume`, `pi -r`, or `pi --session <id>`.

## Types

Owned by `src/domain.ts`:

```ts
export type TaskId = string & { readonly __brand: "TaskId" };
export type ChildPlacement = "tab" | "split";

export interface SpawnTask {
  prompt: string;
  placement?: ChildPlacement; // default: tab
}

export interface SpawnBatchRequest {
  tasks: SpawnTask[]; // 1..4
}

export type ChildStatus =
  "succeeded" | "failed" | "blocked" | "unattributable" | "parent_aborted";

export interface ChildLocation {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface ChildResult {
  taskId: TaskId;
  requestIndex: number;
  status: ChildStatus;
  summary?: string;
  truncated: boolean;
  sessionId?: string;
  sessionPath?: string;
  location?: ChildLocation;
  paneClosed: boolean;
  error?: {
    code:
      | "start_failed"
      | "prompt_failed"
      | "result_unreadable"
      | "blocked"
      | "parent_aborted";
    message: string;
  };
}

export interface SpawnBatchResult {
  requested: number;
  results: ChildResult[]; // request order
  sharedCheckoutWarning?: string;
}
```

Runtime-only host records belong to `src/herdr/host.ts` and are not exposed in the tool schema.

## Interfaces

### Pi tool

Register one tool named `spawn_pi`:

```ts
interface SpawnPiToolInput {
  tasks: Array<{
    prompt: string;
    placement?: "tab" | "split";
  }>;
}
```

The schema requires 1–4 non-empty prompts. Rendering shows task count, progress counts, concise per-task results, session IDs, and retained child locations without displaying full prompt JSON by default.

### Batch runner

Owned by `src/batch.ts`:

```ts
export interface BatchRunner {
  run(
    request: SpawnBatchRequest,
    context: ParentContext,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: BatchProgress) => void;
    }
  ): Promise<SpawnBatchResult>;
}
```

It validates requests, coordinates concurrent children, preserves request order, and aggregates partial failures without persistence beyond the call.

### Child host

Owned by `src/herdr/host.ts`:

```ts
export interface ChildHost {
  inspect(signal?: AbortSignal): Promise<HostInspection>;
  start(request: StartChildRequest, signal?: AbortSignal): Promise<HostedChild>;
  prompt(
    child: HostedChild,
    prompt: string,
    signal?: AbortSignal
  ): Promise<ChildSettlement>;
  close(child: HostedChild, signal?: AbortSignal): Promise<void>;
}
```

Production uses Herdr; tests use a fake host. `close` verifies current-call resource ownership and expected occupant identity.

### Result reader

Owned by `src/results.ts`:

```ts
export interface ChildResultReader {
  read(input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }): Promise<{ summary: string; truncated: boolean }>;
}
```

It is read-only and rejects missing markers, unrelated user interleaving, malformed ancestry, and absent final assistant responses.

## Herdr and Pi integration

Before accepting a batch, confirm `HERDR_ENV=1`, parent workspace/tab/pane IDs, socket reachability, and required schema methods. Package loading outside Herdr remains safe; `spawn_pi` returns an actionable unavailable error.

- Derive capabilities from `herdr api schema --json`; semantic versions are diagnostic only.
- Send one LF-delimited JSON request per ordinary Herdr connection.
- Create tabs or splits without changing focus and retain returned opaque IDs.
- Start Pi in the created pane with deterministic `--session-id`, a unique recognizable name, and `spawn_pi` excluded from child tools.
- Wait for Herdr to recognize Pi before prompting.
- Preserve per-task failures after work begins.
- Log only IDs, Herdr methods, durations, and error codes; omit prompts, answers, environment values, and credentials.

## Project layout

```text
pi-herdr-subagents/
├── package.json                 # Pi package manifest and scripts
├── tsconfig.json                # strict TypeScript settings
├── README.md                    # pilot usage, resume flow, and checkout warning
├── CONTEXT.md                   # canonical terminology and invariants
├── docs/adr/
│   └── 0001-herdr-hosts-child-pi-lifecycle.md
├── specs/
│   ├── pi-herdr-subagents-rfc.md
│   └── pi-herdr-subagents-handoff.md
├── src/
│   ├── index.ts                 # tool registration and lifecycle wiring
│   ├── domain.ts                # batch, task, and result types
│   ├── batch.ts                 # concurrent one-shot orchestration
│   ├── results.ts               # child session attribution
│   ├── tools.ts                 # schema and rendering adapter
│   └── herdr/
│       ├── protocol.ts          # schema inspection and socket framing
│       └── host.ts              # create, prompt, and verified close
└── test/
    ├── support/
    │   ├── fake-herdr-server.ts
    │   └── fake-child-host.ts
    ├── unit/
    │   ├── domain.test.ts
    │   └── results.test.ts
    └── integration/
        ├── batch.test.ts
        └── protocol.test.ts
```

## Delivery and verification

| ID | Deliverable | Effort | Verification | Depends on |
| --- | --- | --: | --- | --- |
| D1 | Package, domain types, tool schema, and fake host | L | Package loading; 1–4 task schema validation | — |
| D2 | Herdr protocol and Child Host | XL | Framing/capability tests; visible opt-in startup | D1 |
| D3 | Result reader | L | Appended JSONL, ancestry, interleaving, and truncation tests | D1 |
| D4 | Batch runner and verified close | XL | Four-way execution, partial failure, blocking, abort, and replaced-occupant tests | D2, D3 |
| D5 | Rendering, README, and pilot hardening | L | Package integration and opt-in live batch acceptance | D4 |

The expert pilot is accepted when:

- [ ] The package loads inside and outside Herdr without crashing Pi.
- [ ] One `spawn_pi` call validates and runs 1–4 independent tasks in request order.
- [ ] Each task starts a fresh visible Pi session in a no-focus tab or requested split, using the Parent Pi's checkout and normal coding tools without access to `spawn_pi`.
- [ ] Four children work concurrently, and partial failures preserve other outcomes.
- [ ] Successful summaries come from the exact task marker and Pi JSONL ancestry; terminal output is never presented as attributed success.
- [ ] Successful children return resumable session IDs and close only after collection and occupant verification.
- [ ] A returned session ID resumes successfully after child closure.
- [ ] Blocked, failed, aborted, and unattributable children remain visible with known locations while the Parent session remains active; owned, verified child panes close on Parent exit or session replacement.
- [ ] Parent abort neither interrupts nor closes accepted child work.
- [ ] Multi-task results warn about unrestricted shared-checkout interference.
- [ ] Logs contain no prompts, answers, environment values, or credentials.

## Pilot limitations

Shared-checkout interference is accepted and requires parent review of the final checkout. Parent abort can leave live children without background collection. Missing session attribution leaves a visible child rather than a best-effort answer. The fixed four-task limit changes only after pilot evidence justifies scheduling or additional runtime management.

## Open questions

None blocking.
