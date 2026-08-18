// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-object-parameters, eslint/arrow-body-style

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  discoverSpawnedChildren,
  formatOrchestratorCost,
  readOrchestratorCost,
  usageCost,
} from "../../src/cost.js";
import type { ChildResult } from "../../src/domain.js";

// SAFETY: Test entries intentionally cover persisted malformed shapes at the cost parser boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const entry = (value: object): SessionEntry => value as unknown as SessionEntry;

const child = (overrides: Partial<ChildResult> = {}): ChildResult => ({
  paneClosed: false,
  requestIndex: 0,
  status: "succeeded",
  taskId: "task-1",
  truncated: false,
  ...overrides,
});

const usage = (total: number | string) => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total },
  input: 0,
  output: 0,
  totalTokens: 0,
});

const session = (id: string, cost: number): string =>
  [
    JSON.stringify({
      cwd: "/tmp",
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session",
      version: 3,
    }),
    JSON.stringify({
      id: "message-1",
      message: {
        api: "test",
        content: [],
        model: "test",
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: 0,
        usage: usage(cost),
      },
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "message",
    }),
  ].join("\n");

void test("sums valid usage sources and ignores invalid costs", () => {
  const entries = [
    entry({
      message: { role: "assistant", usage: usage(1.25) },
      type: "message",
    }),
    entry({
      message: { role: "toolResult", usage: usage(2.5) },
      type: "message",
    }),
    entry({ type: "compaction", usage: usage(3.75) }),
    entry({ type: "branch_summary", usage: usage(4.5) }),
    entry({
      message: { role: "assistant", usage: usage(-1) },
      type: "message",
    }),
    entry({
      message: { role: "assistant", usage: usage(Number.NaN) },
      type: "message",
    }),
    entry({
      message: { role: "assistant", usage: usage(Number.POSITIVE_INFINITY) },
      type: "message",
    }),
    entry({
      message: { role: "assistant", usage: usage("bad") },
      type: "message",
    }),
  ];
  assert.equal(usageCost(entries), 12);
});

void test("discovers wrapped and legacy batches in request order with identity deduplication", () => {
  const first = child({
    requestIndex: 1,
    sessionId: "session-b",
    taskId: "task-2",
  });
  const second = child({
    requestIndex: 0,
    sessionPath: "/tmp/child-a.jsonl",
    taskId: "task-1",
  });
  const duplicate = child({
    requestIndex: 2,
    sessionId: "session-b",
    taskId: "task-3",
  });
  const details = { requested: 2, results: [first, second] };
  const entries = [
    entry({
      message: {
        details: { phase: "working", progress: {} },
        isError: false,
        role: "toolResult",
        toolName: "spawn_pi",
      },
      type: "message",
    }),
    entry({
      message: {
        details: { phase: "finished", result: details },
        isError: false,
        role: "toolResult",
        toolName: "spawn_pi",
      },
      type: "message",
    }),
    entry({
      message: {
        details: { requested: 1, results: [duplicate] },
        isError: false,
        role: "toolResult",
        toolName: "spawn_pi",
      },
      type: "message",
    }),
  ];
  assert.deepEqual(
    discoverSpawnedChildren(entries).map((result) => result.taskId),
    ["task-1", "task-2"]
  );
});

void test("parses persisted timed-out results with elapsed time", () => {
  const timedOut = child({
    elapsedMs: 1000,
    error: {
      code: "timed_out",
      message: "Child exceeded the global runtime timeout",
    },
    paneClosed: true,
    sessionId: "timed-out-session",
    status: "timed_out",
  });
  const entries = [
    entry({
      message: {
        details: { requested: 1, results: [timedOut] },
        isError: false,
        role: "toolResult",
        toolName: "spawn_pi",
      },
      type: "message",
    }),
  ];

  assert.deepEqual(discoverSpawnedChildren(entries), [timedOut]);
});

void test("reads each child once, tolerates malformed trailing lines, and falls back on lookup failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-herdr-cost-"));
  const firstPath = path.join(directory, "first.jsonl");
  const secondPath = path.join(directory, "second.jsonl");
  try {
    await writeFile(
      firstPath,
      `${session("first", 1.25)}\nmalformed trailing line\n`
    );
    await writeFile(secondPath, session("second", 2.5));
    const first = child({ sessionId: "first", sessionPath: firstPath });
    const second = child({
      requestIndex: 1,
      sessionId: "second",
      sessionPath: secondPath,
      status: "blocked",
      taskId: "task-2",
    });
    const parentEntries = [
      entry({
        message: {
          details: { requested: 2, results: [first, second] },
          isError: false,
          role: "toolResult",
          toolName: "spawn_pi",
        },
        type: "message",
      }),
    ];
    let lookups = 0;
    const snapshot = await readOrchestratorCost(
      parentEntries,
      async (value) => {
        await Promise.resolve();
        lookups += 1;
        if (value.sessionId === "first") {
          throw new Error("pane vanished");
        }
        return "open";
      }
    );
    assert.equal(lookups, 2);
    assert.deepEqual(
      snapshot.children.map((value) => value.cost),
      [1.25, 2.5]
    );
    assert.deepEqual(
      snapshot.children.map((value) => value.status),
      ["complete", "open"]
    );
    assert.equal(snapshot.childrenCost, 3.75);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

void test("does not report a closed timed-out child as open on cost fallback", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pi-herdr-cost-timeout-")
  );
  const sessionPath = path.join(directory, "timed-out.jsonl");
  try {
    await writeFile(sessionPath, session("timed-out", 1.5));
    const timedOut = child({
      elapsedMs: 1000,
      error: { code: "timed_out", message: "runtime timed out" },
      paneClosed: true,
      sessionId: "timed-out",
      sessionPath,
      status: "timed_out",
    });
    const parentEntries = [
      entry({
        message: {
          details: { requested: 1, results: [timedOut] },
          isError: false,
          role: "toolResult",
          toolName: "spawn_pi",
        },
        type: "message",
      }),
    ];
    const snapshot = await readOrchestratorCost(parentEntries, async () => {
      await Promise.resolve();
      throw new Error("closed pane unavailable");
    });

    assert.equal(snapshot.children[0]?.status, "complete");
    assert.equal(snapshot.children[0]?.cost, 1.5);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

void test("marks invalid or missing child sessions unavailable without affecting totals", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pi-herdr-cost-unavailable-")
  );
  const invalidPath = path.join(directory, "invalid.jsonl");
  const missingPath = path.join(directory, "missing.jsonl");
  try {
    await writeFile(invalidPath, JSON.stringify({ type: "message" }));
    const parentEntries = [
      entry({
        message: { role: "assistant", usage: usage(0.5) },
        type: "message",
      }),
      entry({
        message: {
          details: {
            requested: 2,
            results: [
              child({ sessionId: "invalid", sessionPath: invalidPath }),
              child({
                requestIndex: 1,
                sessionId: "missing",
                sessionPath: missingPath,
                taskId: "task-2",
              }),
            ],
          },
          isError: false,
          role: "toolResult",
          toolName: "spawn_pi",
        },
        type: "message",
      }),
    ];
    let lookups = 0;
    const snapshot = await readOrchestratorCost(parentEntries, async () => {
      await Promise.resolve();
      lookups += 1;
      return "running";
    });
    assert.equal(lookups, 0);
    assert.deepEqual(
      snapshot.children.map((value) => [value.status, value.cost]),
      [
        ["unavailable", undefined],
        ["unavailable", undefined],
      ]
    );
    assert.equal(snapshot.parentCost, 0.5);
    assert.equal(snapshot.childrenCost, 0);
    assert.equal(snapshot.totalCost, 0.5);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

void test("formats no-child and mixed snapshots with stable four-decimal rows", () => {
  const output = formatOrchestratorCost({
    children: [
      {
        cost: 0.02136,
        sessionId: "a1b2c3d4-long",
        status: "complete",
        taskId: "task-1",
      },
      {
        sessionPath: "/tmp/e5f6a7b8.jsonl",
        status: "unavailable",
        taskId: "task-2",
      },
    ],
    childrenCost: 0.02136,
    parentCost: 0.18424,
    totalCost: 0.2056,
  });
  assert.equal(
    output,
    [
      "Orchestrator cost · current session",
      "",
      "Parent                              $0.1842",
      "Children",
      "  task-1 · a1b2c3d4 · complete      $0.0214",
      "  task-2 · e5f6a7b8 · unavailable   —",
      "Children subtotal                   $0.0214",
      "Total                               $0.2056",
    ].join("\n")
  );
  assert.equal(
    formatOrchestratorCost({
      children: [],
      childrenCost: 0,
      parentCost: 0,
      totalCost: 0,
    }),
    [
      "Orchestrator cost · current session",
      "",
      "Parent                              $0.0000",
      "Children  none",
      "Children subtotal                   $0.0000",
      "Total                               $0.0000",
    ].join("\n")
  );
});
