# Pi Herdr Context Offloading — Implementation Handoff

**Status:** Ready for task breakdown  
**Effort:** XL; approximately 4–7 focused engineering days  
**Confidence:** 70%

## Product

Implement one Pi tool, `spawn_pi`, that turns a batch of 1–4 independent prompts into concurrent fresh Pi sessions hosted visibly by Herdr. Return concise attributed answers and resumable session IDs. Close successfully collected children; leave problem children visible.

The authoritative contract is `specs/pi-herdr-subagents-rfc.md`.

## Scope boundary

Build only:

- one batch tool;
- fresh one-shot Child Pis;
- tabs by default and optional splits;
- concurrent execution without a queue;
- normal child coding tools with child spawning excluded;
- Pi-session result attribution;
- partial batch results;
- verified close after successful collection;
- graceful no-Herdr behavior;
- fake protocol/host tests and an opt-in live check.

Do not build definitions, reusable runtimes, persistence, recovery, cancellation, deadlines, worktrees, commands, widgets, scheduling, cleanup, or adoption.

## Key decisions

- Fresh context is the product; children are never reused by orchestration.
- Each child receives exactly one marked task.
- The fixed batch limit is four.
- All children use the Parent Pi's checkout and full core coding tools.
- Concurrent write interference is accepted and prominently reported.
- Herdr owns topology and processes; the extension closes only verified resources it created.
- Pi JSONL session ancestry is the only successful result source.
- Parent abort leaves accepted children running and visible.
- Successful children close after answer and session ID collection.
- Problem children remain visible.

## Ordered implementation

1. **D1 — Package and contracts** (L)
   - Add strict TypeScript/package skeleton.
   - Define batch types and validate the one-tool schema.
   - Add `FakeChildHost`.
   - Verify: package loads and schema accepts 1–4 non-empty tasks.

2. **D2 — Herdr child host** (XL, depends on D1)
   - Inspect installed schema and parent identity.
   - Implement LF-delimited request transport.
   - Create no-focus tabs/splits, start recognized Pi, prompt, and verified close.
   - Verify: fake socket tests plus one visible opt-in child startup.

3. **D3 — Result reader** (L, depends on D1)
   - Read the child Pi session by deterministic session ID/path.
   - Attribute final response through exact task marker and ancestry.
   - Reject interleaving and missing/malformed results.
   - Verify: live-appended JSONL fixtures and truncation tests.

4. **D4 — Batch runner** (XL, depends on D2 and D3)
   - Start all children concurrently.
   - Aggregate results in request order.
   - Close only successfully collected and identity-verified children.
   - Preserve partial failures and leave problem panes visible.
   - Verify: four-way fake-host execution, partial failure, blocked child, parent abort, and replaced occupant tests.

5. **D5 — Tool rendering and pilot hardening** (L, depends on D4)
   - Add progress counts and concise results.
   - Return session IDs and retained Herdr locations.
   - Add shared-checkout warning for multi-task batches.
   - Document session resume and risks.
   - Verify: package-loading and opt-in live batch acceptance.

## Interfaces

```ts
interface BatchRunner {
  run(
    request: SpawnBatchRequest,
    context: ParentContext,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: BatchProgress) => void;
    },
  ): Promise<SpawnBatchResult>;
}

interface ChildHost {
  inspect(signal?: AbortSignal): Promise<HostInspection>;
  start(request: StartChildRequest, signal?: AbortSignal): Promise<HostedChild>;
  prompt(child: HostedChild, prompt: string, signal?: AbortSignal): Promise<ChildSettlement>;
  close(child: HostedChild, signal?: AbortSignal): Promise<void>;
}

interface ChildResultReader {
  read(input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }): Promise<{ summary: string; truncated: boolean }>;
}
```

## Target project layout

```text
src/
├── index.ts
├── domain.ts
├── batch.ts
├── results.ts
├── tools.ts
└── herdr/
    ├── protocol.ts
    └── host.ts

test/
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

## Release gate

The pilot is complete when one Parent Pi can request four independent tasks, observe four fresh Child Pis working concurrently, receive attributed per-task answers and session IDs, automatically close successful children, and inspect any unsuccessful child left open.

No deferred orchestration feature is part of this release gate.
