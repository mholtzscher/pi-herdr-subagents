# Orchestrator Cost — Implementation Spec

**Status:** Implemented  
**Effort:** M (1–3 hours)  
**Approved by:** User  
**Date:** 2026-08-16

## Goal and Chosen Design

Add `/orchestrator cost` so a Parent Pi user can see the cost accumulated by the current Parent session and its Child Pi sessions without opening each session.

The command renders one human-readable persisted snapshot with Parent cost, one row per uniquely identified child, a children subtotal, and a grand total. Parent usage comes from the current `SessionManager`; children are discovered from persisted `spawn_pi` tool results and read from their JSONL files. Best-effort Herdr `agent.get` calls annotate open children but are not required for cost reporting.

This source of truth survives pane closure, reload, resume, compaction, and tree navigation without another ledger.

## Accounting and Discovery Contract

1. **Current session** means every entry returned by the current Parent `SessionManager.getEntries()`, including abandoned branches and compacted history. This matches Pi's `/session` accounting.
2. `usageCost` sums `usage.cost.total` from assistant messages, tool-result messages with usage, compaction entries, and branch-summary entries. It accepts a value only when it is a finite, non-negative number. Summation uses full precision; formatting rounds USD values to four decimal places.
3. `discoverSpawnedChildren` scans Parent entries in entry order and accepts only non-error `spawn_pi` tool-result messages whose details are either `{ phase: "finished", result: SpawnBatchResult }` or the legacy raw `SpawnBatchResult` shape supported by the renderer. TypeBox schemas validate persisted details; working, unrelated, and malformed results are ignored.
4. Preserve first discovery order: Parent entry order, then ascending `requestIndex` within each batch. Deduplicate by full `sessionId`, or by `path.resolve(sessionPath)` when no ID exists; the first valid record wins. Tasks without either identity are omitted.
5. Each child file is read at most once per invocation. Child workflows run concurrently and use Pi's `parseSessionEntries` to tolerate blank or malformed lines, including a concurrently written trailing line. A child is readable only when the read succeeds and the first parsed entry is a valid session header; a missing path, failed read, or missing/invalid header makes it `unavailable`.
6. A readable child contributes all usage persisted at read time. An unavailable child displays cost `—` and is excluded from both totals. The command does not wait for an in-flight response; that response contributes after Pi persists it.
7. Reported values are Pi-recorded model-cost estimates, not invoices. Historical usage is never repriced from current model rates.

The first version is current-session and human-readable only: no cross-session aggregation, JSON output, token/rate detail, or polling UI.

## Types and Accounting API — `src/cost.ts`

```ts
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ChildResult, TaskId } from "./domain.js";

export type ChildCostStatus =
  "complete" | "running" | "blocked" | "open" | "unavailable";

export interface ChildCostSnapshot {
  taskId: TaskId;
  sessionId?: string;
  sessionPath?: string;
  status: ChildCostStatus;
  /** Undefined only when the child session is unavailable. */
  cost?: number;
}

export interface OrchestratorCostSnapshot {
  parentCost: number;
  children: ChildCostSnapshot[];
  childrenCost: number;
  totalCost: number;
}

export type ChildStatusLookup = (
  child: ChildResult
) => Promise<ChildCostStatus | undefined>;

export function usageCost(entries: readonly SessionEntry[]): number;

export function discoverSpawnedChildren(
  entries: readonly SessionEntry[]
): ChildResult[];

export async function readOrchestratorCost(
  parentEntries: readonly SessionEntry[],
  lookupStatus: ChildStatusLookup
): Promise<OrchestratorCostSnapshot>;

export function formatOrchestratorCost(
  snapshot: OrchestratorCostSnapshot
): string;

export const lookupHerdrChildStatus: ChildStatusLookup;
```

`usageCost` and `discoverSpawnedChildren` are pure. `readOrchestratorCost` catches file and lookup failures per child. For each readable child, an injected status wins; otherwise `succeeded` maps to `complete`, `blocked` to `blocked`, and every other stored result to `open`. An unreadable child is always `unavailable`, and no status lookup is required for it. `childrenCost` is the sum of defined child costs, and `totalCost = parentCost + childrenCost`.

TypeBox schemas and `Check` perform persisted-data and Herdr response narrowing; do not use unchecked assertions. The snapshot retains full identities, and only the formatter shortens them.

`src/cost.ts` also exports `lookupHerdrChildStatus: ChildStatusLookup`. It calls `agent.get` only when the child has a complete location and session identity, using `HERDR_SOCKET_PATH` and the recorded pane ID. It accepts the current response shape only when workspace, tab, pane, and agent-session identity match the child. Match `agent_session.kind === "id"` to `sessionId` or `kind === "path"` to the resolved `sessionPath`. Map `working` to `running`, `blocked` to `blocked`, and `idle` to `open`; an unknown state or any environment, protocol, shape, pane, occupant, or identity failure returns `undefined`.

Accounting, Herdr lookup, and formatting remain owned by `src/cost.ts`; spawn-domain, persistence, and configuration types do not change.

## Command Integration

Change `registerOrchestrator` to accept `lookupChildStatus: ChildStatusLookup`, add `cost` to completions and usage guidance, remove the now-stale `require-await` suppression above the command handler, and dispatch it as follows:

```ts
if (action === "cost") {
  const snapshot = await readOrchestratorCost(
    ctx.sessionManager.getEntries(),
    lookupChildStatus
  );
  ctx.ui.notify(formatOrchestratorCost(snapshot), "info");
  return;
}
```

Handle `cost` before the existing mode-availability guard. It is read-only and works whether Orchestrator Mode is enabled, disabled, or temporarily unavailable; existing empty-argument toggle, state restoration, status, and availability behavior remain unchanged. Inject `lookupHerdrChildStatus` from `src/index.ts`. Unit command tests inject a stub and therefore require neither Herdr nor filesystem setup. The first version uses `ctx.ui.notify`, not a custom TUI component.

## Output Contract

```text
Orchestrator cost · current session

Parent                              $0.1842
Children
  task-1 · a1b2c3d4 · complete      $0.0214
  task-2 · e5f6a7b8 · running       $0.0081

Children subtotal                   $0.0295
Total                               $0.2137
```

A child label is `taskId · <short identifier> · status`; the identifier is the first eight session-ID characters, or the child session filename without `.jsonl`, shortened to eight characters, or `unknown`. With no children, render `Children  none`, a `$0.0000` children subtotal, and the Parent-derived total. Rows align deterministically, and formatter tests assert exact output.

## Implementation Ownership

| Step | Files | Responsibility |
| --- | --- | --- |
| D1 | `src/cost.ts`, `test/unit/cost.test.ts` | Usage validation, discovery, ordering, deduplication, snapshots, fallback status, and formatting |
| D2 | `src/cost.ts`, `test/integration/cost.test.ts` | Fake-server response validation, identity checks, status mapping, and failure fallback |
| D3 | `src/orchestrator.ts`, `src/index.ts`, `test/unit/orchestrator.test.ts` | Completion, dispatch before availability gating, injection, notification, and existing regressions |
| D4 | `README.md` | Command, persisted-snapshot timing, current-session scope, and estimate caveat |

## Acceptance and Verification

| Requirement | Verification |
| --- | --- |
| Parent and child totals include all four persisted usage sources across all Parent entries; invalid values are ignored and historical costs are not repriced. | `test/unit/cost.test.ts`: each source, non-active branches, zero/negative/non-number/non-finite values |
| Every identified child appears once in first discovery order; repeated `task-N` labels remain distinct, duplicate identities contribute once, and malformed details are ignored. | `test/unit/cost.test.ts`: wrapped/raw details, multiple batches, ordering, identity fallback, deduplication, malformed details |
| Readable children contribute the persisted snapshot; missing or invalid files are `unavailable`; malformed trailing lines are tolerated; status and file failures do not fail the report. | `test/unit/cost.test.ts`: valid/invalid headers, missing files, malformed trailing lines, concurrent reads, lookup failures, fallback states |
| Herdr state is trusted only for the matching child and maps `working`, `blocked`, and `idle` as specified. | `test/integration/cost.test.ts`: ID/path matches, state mapping, unknown states, malformed responses, location/occupant mismatch, missing pane, socket failure |
| `/orchestrator cost` displays Parent, each child, children subtotal, and grand total with exact alignment and four-decimal formatting; it works while mode is enabled, disabled, or unavailable and appears in completion and usage guidance. | `test/unit/cost.test.ts`: exact no-child, repeated-label, mixed, unavailable, and rounding output; `test/unit/orchestrator.test.ts`: routing, completion, notification, invalid usage, existing regressions |
| README states current-session scope, persisted-snapshot timing, and estimate caveat. | Documentation review |
| Repository validation passes. | `devenv test` (`pnpm check` and `pnpm test`) |

## Open Decisions

None.
