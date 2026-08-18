// oxlint-disable promise/avoid-new
import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Type } from "typebox";
import { Check } from "typebox/value";

import { ConcurrentBatchRunner } from "../../src/batch.js";
import { taskIdFor } from "../../src/domain.js";
import type { BatchProgress } from "../../src/domain.js";
import {
  HerdrChildHost,
  SessionChildRegistry,
  StartChildError,
} from "../../src/herdr/host.js";
import type { ChildSettlement } from "../../src/herdr/host.js";
import type { HerdrRequest } from "../../src/herdr/protocol.js";
import type { ChildResultReader } from "../../src/results.js";
import { FakeChildHost, parentContext } from "../support/fake-child-host.js";
import { createFakeHerdrServer } from "../support/fake-herdr-server.js";

class Reader implements ChildResultReader {
  // oxlint-disable-next-line eslint/class-methods-use-this
  async read(input: {
    taskId: string;
  }): Promise<{ summary: string; truncated: boolean }> {
    return await Promise.resolve({
      summary: `answer for ${input.taskId}`,
      truncated: false,
    });
  }
}

interface CapturedHerdrCall {
  method: string;
  params: { args?: string[]; label?: string };
}

const CapturedHerdrParamsSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    label: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

const captureHerdrCall = (request: HerdrRequest): CapturedHerdrCall => {
  if (!Check(CapturedHerdrParamsSchema, request.params)) {
    throw new TypeError("Unexpected Herdr request params");
  }
  const params: CapturedHerdrCall["params"] = {};
  if (request.params.args !== undefined) {
    params.args = request.params.args;
  }
  if (request.params.label !== undefined) {
    params.label = request.params.label;
  }
  return { method: request.method, params };
};

const readyShell = () => ({
  process_info: { foreground_processes: [{ pid: 101 }], shell_pid: 101 },
});

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Drain sequential promise continuations.
    await Promise.resolve();
  }
};

void test("rejects spawn outside a Herdr Parent pane without crashing", async () => {
  const original = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try {
    await assert.rejects(
      async () => await new HerdrChildHost().inspect(),
      /HERDR_ENV=1/u
    );
  } finally {
    if (original === undefined) {
      delete process.env.HERDR_ENV;
    } else {
      process.env.HERDR_ENV = original;
    }
  }
});

void test("labels the Parent tab and every visible child surface with its readable Parent identity", async () => {
  const calls: CapturedHerdrCall[] = [];
  const server = await createFakeHerdrServer((request) => {
    calls.push(captureHerdrCall(request));
    if (request.method === "tab.create") {
      return { root_pane: { pane_id: "w21:p9" }, tab: { tab_id: "w21:t2" } };
    }
    if (request.method === "pane.process_info") {
      return readyShell();
    }
    if (request.method === "agent.start") {
      return {};
    }
    return {
      agent: {
        agent_session: { kind: "path", value: "/missing.jsonl" },
        terminal_id: "term-1",
      },
    };
  });
  try {
    const context = { ...parentContext, parentLabel: "Amber Finch" };
    await new HerdrChildHost().start({
      context,
      parent: {
        paneId: "w21:p1",
        socketPath: server.path,
        tabId: "w21:t1",
        workspaceId: "w21",
      },
      placement: "tab",
      sessionId: "child",
      taskId: taskIdFor(0),
    });
    await new HerdrChildHost().renameParent(
      {
        paneId: "w21:p1",
        socketPath: server.path,
        tabId: "w21:t1",
        workspaceId: "w21",
      },
      context
    );
    const parentTab = calls.find((call) => call.method === "tab.rename");
    const tab = calls.find((call) => call.method === "tab.create");
    const pane = calls.find((call) => call.method === "pane.rename");
    const start = calls.find((call) => call.method === "agent.start");
    assert.equal(parentTab?.params.label, "Pi [amber-finch]");
    assert.equal(tab?.params.label, "Pi [amber-finch] task-1");
    assert.equal(pane?.params.label, "Pi [amber-finch] task-1");
    const args = start?.params.args;
    assert.ok(args);
    assert.ok(args.includes("Pi [amber-finch] task-1"));
    assert.deepEqual(args.slice(-6), [
      "--exclude-tools",
      "spawn_pi",
      "--model",
      "openai/test",
      "--thinking",
      "low",
    ]);
  } finally {
    await server.close();
  }
});

void test("retries child startup until the pane and its shell are ready", async () => {
  const readinessErrors = [
    Object.assign(new Error("agent target pane w21:p9 not found"), {
      code: "agent_pane_not_found",
    }),
    Object.assign(new Error("agent target pane w21:p9 has no live terminal"), {
      code: "agent_pane_unavailable",
    }),
    Object.assign(
      new Error("agent target pane w21:p9 is not an available shell"),
      { code: "agent_pane_busy" }
    ),
  ];
  let startAttempts = 0;
  let processPolls = 0;
  const controller = new AbortController();
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") {
      return { root_pane: { pane_id: "w21:p9" }, tab: { tab_id: "w21:t2" } };
    }
    if (request.method === "pane.process_info") {
      processPolls += 1;
      return readyShell();
    }
    if (request.method === "agent.start") {
      const error = readinessErrors[startAttempts];
      startAttempts += 1;
      if (error !== undefined) {
        throw error;
      }
      return {};
    }
    return {
      agent: {
        agent_session: { kind: "path", value: "/missing.jsonl" },
        terminal_id: "term-1",
      },
    };
  });
  try {
    await new HerdrChildHost().start(
      {
        context: parentContext,
        parent: {
          paneId: "w21:p1",
          socketPath: server.path,
          tabId: "w21:t1",
          workspaceId: "w21",
        },
        placement: "tab",
        sessionId: "child",
        taskId: taskIdFor(0),
      },
      controller.signal
    );
    assert.equal(startAttempts, 4);
    assert.equal(processPolls, 12);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await server.close();
  }
});

void test("waits for a stable foreground shell before starting a child", async () => {
  const foregroundPids = [101, 202, 101, 101, 101];
  let processAttempts = 0;
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") {
      return { root_pane: { pane_id: "w21:p9" }, tab: { tab_id: "w21:t2" } };
    }
    if (request.method === "pane.process_info") {
      processAttempts += 1;
      if (processAttempts === 1) {
        throw Object.assign(new Error("pane not found"), {
          code: "pane_not_found",
        });
      }
      const pid = foregroundPids.shift();
      assert.notEqual(pid, undefined);
      return {
        process_info: { foreground_processes: [{ pid }], shell_pid: 101 },
      };
    }
    if (request.method === "agent.start") {
      assert.equal(foregroundPids.length, 0);
      return {};
    }
    return {
      agent: {
        agent_session: { kind: "path", value: "/missing.jsonl" },
        terminal_id: "term-1",
      },
    };
  });
  try {
    await new HerdrChildHost().start({
      context: parentContext,
      parent: {
        paneId: "w21:p1",
        socketPath: server.path,
        tabId: "w21:t1",
        workspaceId: "w21",
      },
      placement: "tab",
      sessionId: "child",
      taskId: taskIdFor(0),
    });
    assert.equal(processAttempts, 6);
  } finally {
    await server.close();
  }
});

void test("polls through a null child session until Herdr reports its path", async () => {
  let sessionPolls = 0;
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") {
      return { root_pane: { pane_id: "w21:p9" }, tab: { tab_id: "w21:t2" } };
    }
    if (request.method === "pane.process_info") {
      return readyShell();
    }
    if (request.method === "agent.start") {
      return {};
    }
    if (request.method === "agent.get") {
      sessionPolls += 1;
      return {
        agent: {
          agent_session:
            sessionPolls === 1
              ? null
              : { kind: "path", value: "/missing.jsonl" },
          terminal_id: "term-1",
        },
      };
    }
    return {};
  });
  try {
    const child = await new HerdrChildHost().start({
      context: parentContext,
      parent: {
        paneId: "w21:p1",
        socketPath: server.path,
        tabId: "w21:t1",
        workspaceId: "w21",
      },
      placement: "tab",
      sessionId: "child",
      taskId: taskIdFor(0),
    });
    assert.equal(sessionPolls, 2);
    assert.equal(child.sessionPath, "/missing.jsonl");
  } finally {
    await server.close();
  }
});

void test("passes selected role identity through a private temporary file", async () => {
  const calls: CapturedHerdrCall[] = [];
  let promptPath = "";
  let promptContents = "";
  let promptMode = 0;
  const server = await createFakeHerdrServer((request) => {
    const call = captureHerdrCall(request);
    calls.push(call);
    if (call.method === "tab.create") {
      return { root_pane: { pane_id: "w21:p9" }, tab: { tab_id: "w21:t2" } };
    }
    if (call.method === "pane.process_info") {
      return readyShell();
    }
    if (call.method === "agent.start") {
      const { args } = call.params;
      assert.ok(args);
      promptPath = args.at(-1) ?? "";
      promptContents = readFileSync(promptPath, "utf-8");
      promptMode = statSync(promptPath).mode;
      return {};
    }
    return {
      agent: {
        agent_session: { kind: "path", value: "/missing.jsonl" },
        terminal_id: "term-1",
      },
    };
  });
  try {
    const prompt = "Read only.\n\nPreserve 'quotes' and $variables.";
    const pending = new HerdrChildHost().start({
      context: parentContext,
      parent: {
        paneId: "w21:p1",
        socketPath: server.path,
        tabId: "w21:t1",
        workspaceId: "w21",
      },
      placement: "tab",
      rolePrompt: prompt,
      sessionId: "child",
      taskId: taskIdFor(0),
    });
    await pending;
    const args = calls.find((call) => call.method === "agent.start")?.params
      .args;
    assert.ok(args);
    promptPath = args.at(-1) ?? "";
    assert.equal(args.at(-2), "--append-system-prompt");
    assert.doesNotMatch(promptPath, /[\r\n]/u);
    await assert.rejects(access(promptPath));

    assert.equal(promptContents, `Child role instructions:\n${prompt}`);
    assert.equal(promptMode % 0o1000, 0o600);
  } finally {
    await server.close();
  }
});

void test("removes the temporary role prompt when child startup fails", async () => {
  let promptPath = "";
  const server = await createFakeHerdrServer((request) => {
    const call = captureHerdrCall(request);
    if (call.method === "tab.create") {
      return { root_pane: { pane_id: "w21:p9" }, tab: { tab_id: "w21:t2" } };
    }
    if (call.method === "pane.process_info") {
      return readyShell();
    }
    if (call.method === "agent.start") {
      const { args } = call.params;
      assert.ok(args);
      promptPath = args.at(-1) ?? "";
      throw new Error("start rejected");
    }
    return { agent: { terminal_id: "term-1" } };
  });
  try {
    await assert.rejects(
      async () =>
        await new HerdrChildHost().start({
          context: parentContext,
          parent: {
            paneId: "w21:p1",
            socketPath: server.path,
            tabId: "w21:t1",
            workspaceId: "w21",
          },
          placement: "tab",
          rolePrompt: "Read only.",
          sessionId: "child",
          taskId: taskIdFor(0),
        }),
      /start rejected/u
    );
    await assert.rejects(access(promptPath));
  } finally {
    await server.close();
  }
});

void test("does not start children when the Parent tab cannot be renamed", async () => {
  const host = new FakeChildHost();
  host.renameError = new Error("tab rename rejected");
  const snapshots: BatchProgress[] = [];

  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    undefined,
    {
      onProgress: (snapshot) => {
        snapshots.push(snapshot);
      },
    }
  );

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["failed", "failed"]
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.results.length),
    [0, 2]
  );
  assert.equal(host.started.length, 0);
  assert.deepEqual(host.parentLabels, []);
});

void test("retains the known child location when startup fails after creation", async () => {
  const host = new FakeChildHost();
  host.start = (request) => {
    throw new StartChildError("Pi did not register", {
      agentName: "pi_task_1",
      location: { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      sessionId: request.sessionId,
      taskId: request.taskId,
      terminalId: "term-1",
    });
  };

  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext
  );

  assert.equal(result.results[0].status, "failed");
  assert.deepEqual(result.results[0].location, {
    paneId: "w1:p2",
    tabId: "w1:t2",
    workspaceId: "w1",
  });
  assert.ok(result.results[0].sessionId !== undefined);
});

void test("does not close a pane whose Herdr occupant changed", async () => {
  const calls: string[] = [];
  const server = await createFakeHerdrServer((request) => {
    calls.push(request.method);
    return { agent: { pane_id: "w1:p2", terminal_id: "replacement" } };
  });
  const originalSocketPath = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = server.path;
  try {
    const host = new HerdrChildHost();
    await assert.rejects(async () => {
      await host.close({
        agentName: "pi_task_1",
        location: { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
        sessionId: "child",
        taskId: taskIdFor(0),
        terminalId: "expected",
      });
    });
    assert.deepEqual(calls, ["agent.get"]);
  } finally {
    if (originalSocketPath === undefined) {
      delete process.env.HERDR_SOCKET_PATH;
    } else {
      process.env.HERDR_SOCKET_PATH = originalSocketPath;
    }
    await server.close();
  }
});

void test("closes a child only when terminal and generated session identities match", async () => {
  const calls: string[] = [];
  const sessionPath = "/tmp/2026-01-01_child.jsonl";
  const server = await createFakeHerdrServer((request) => {
    calls.push(request.method);
    if (request.method === "agent.get") {
      return {
        agent: {
          agent_session: { kind: "path", value: sessionPath },
          pane_id: "w1:p2",
          terminal_id: "expected",
        },
      };
    }
    return {};
  });
  const originalSocketPath = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = server.path;
  try {
    await new HerdrChildHost().close({
      agentName: "pi_task_1",
      location: { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      sessionId: "child",
      sessionPath,
      taskId: taskIdFor(0),
      terminalId: "expected",
    });
    assert.deepEqual(calls, ["agent.get", "pane.close"]);
  } finally {
    if (originalSocketPath === undefined) {
      delete process.env.HERDR_SOCKET_PATH;
    } else {
      process.env.HERDR_SOCKET_PATH = originalSocketPath;
    }
    await server.close();
  }
});

void test("does not adopt a replacement occupant discovered during startup cleanup", async () => {
  const calls: string[] = [];
  const replacementPath = "/tmp/2026-01-01_replacement.jsonl";
  const server = await createFakeHerdrServer((request) => {
    calls.push(request.method);
    return {
      agent: {
        agent_session: { kind: "path", value: replacementPath },
        pane_id: "w1:p2",
        terminal_id: "replacement-terminal",
      },
    };
  });
  const originalSocketPath = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = server.path;
  try {
    const host = new HerdrChildHost();
    await assert.rejects(async () => {
      await host.close({
        agentName: "pi_task_1",
        location: { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
        sessionId: "expected-child",
        sessionPath: replacementPath,
        taskId: taskIdFor(0),
        terminalId: "replacement-terminal",
      });
    });
    assert.deepEqual(calls, ["agent.get"]);
  } finally {
    if (originalSocketPath === undefined) {
      delete process.env.HERDR_SOCKET_PATH;
    } else {
      process.env.HERDR_SOCKET_PATH = originalSocketPath;
    }
    await server.close();
  }
});

void test("runs four children concurrently, preserves request order, and closes successes", async () => {
  const host = new FakeChildHost();
  for (let index = 1; index <= 4; index += 1) {
    host.sessionPaths.set(taskIdFor(index - 1), `/tmp/${index}.jsonl`);
  }
  const start = host.start.bind(host);
  const started = new Set<string>();
  const allStarted = new EventTarget();
  const allStartedSignal = once(allStarted, "ready");
  host.start = async (request) => {
    started.add(request.taskId);
    if (started.size === 4) {
      allStarted.dispatchEvent(new Event("ready"));
    }
    await allStartedSignal;
    return await start(request);
  };
  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    {
      tasks: [
        { prompt: "one" },
        { prompt: "two" },
        { prompt: "three" },
        { prompt: "four" },
      ],
    },
    parentContext
  );
  assert.deepEqual(
    result.results.map((child) => child.taskId),
    ["task-1", "task-2", "task-3", "task-4"]
  );
  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "succeeded", "succeeded", "succeeded"]
  );
  assert.equal(host.closed.length, 4);
  assert.deepEqual(
    host.startRequests.map((request) => request.placement),
    ["tab", "tab", "tab", "tab"]
  );
  assert.deepEqual(host.parentLabels, ["Pi [w1-p1]"]);
});

void test("uses one configured placement for every child and falls back to tab", async () => {
  const placements = [
    [undefined, "tab"],
    ["tab", "tab"],
    ["split", "split"],
  ] as const;
  await Promise.all(
    placements.map(async ([placement, expected]) => {
      const host = new FakeChildHost();
      await new ConcurrentBatchRunner(host, new Reader()).run(
        { tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] },
        parentContext,
        {
          availableModels: [],
          config: {
            defaults: placement === undefined ? {} : { placement },
            roles: {},
          },
        }
      );
      assert.deepEqual(
        host.startRequests.map((request) => request.placement),
        [expected, expected, expected]
      );
    })
  );
});

void test("emits immutable request-ordered progress snapshots from initial through final settlement", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(1), "/tmp/two.jsonl");
  const prompt = host.prompt.bind(host);
  const progressEvents = new EventTarget();
  const firstPending = once(progressEvents, "first");
  const secondComplete = once(progressEvents, "second");
  const releaseFirst = () => progressEvents.dispatchEvent(new Event("first"));
  const secondSettled = () => progressEvents.dispatchEvent(new Event("second"));
  host.prompt = async (child, taskPrompt) => {
    if (child.taskId === "task-1") {
      await firstPending;
    } else {
      secondSettled();
    }
    return await prompt(child, taskPrompt);
  };
  const snapshots: BatchProgress[] = [];
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    undefined,
    {
      onProgress: (snapshot) => {
        snapshots.push(snapshot);
      },
    }
  );

  await secondComplete;
  await delay(0);
  releaseFirst();
  const result = await pending;

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.results.map((child) => child.taskId)),
    [[], ["task-2"], ["task-1", "task-2"]]
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.completed),
    [0, 1, 2]
  );
  assert.notStrictEqual(snapshots[0].results, snapshots[1].results);
  assert.notStrictEqual(snapshots[1].results, snapshots[2].results);
  assert.strictEqual(snapshots[2].results[0], result.results[0]);
  assert.strictEqual(snapshots[2].results[1], result.results[1]);
});

void test("preserves partial failures and blocked children without closing them", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.promptErrors.set(taskIdFor(1), new Error("prompt rejected"));
  host.settlements.set(taskIdFor(2), { status: "blocked" });
  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] },
    parentContext
  );
  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "failed", "blocked"]
  );
  assert.equal(host.closed.length, 1);
  assert.equal(result.results[1].error?.code, "prompt_failed");
  assert.equal(result.results[2].error?.code, "blocked");
});

void test("routes independent tasks while leaving route failures pane-free", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(3), "/tmp/four.jsonl");
  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    {
      tasks: [
        { prompt: "one", role: "explore" },
        { prompt: "two", role: "missing" },
        { model: "missing/model", prompt: "three" },
        { model: "routed/model", prompt: "four", thinking: "off" },
        { prompt: "five", role: "unavailable" },
      ],
    },
    parentContext,
    {
      availableModels: [{ id: "model", provider: "routed" }],
      config: {
        defaults: { thinking: "medium" },
        roles: {
          explore: {
            model: ["missing/model", "routed/model"],
            prompt: "Read only.",
            thinking: "low",
          },
          unavailable: {
            model: ["private/first", "private/model"],
            prompt: "Private role.",
          },
        },
      },
    }
  );

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "failed", "failed", "succeeded", "failed"]
  );
  assert.deepEqual(
    result.results.map((child) => child.error?.code),
    [
      undefined,
      "role_not_found",
      "model_routing_failed",
      undefined,
      "model_routing_failed",
    ]
  );
  assert.deepEqual(
    host.started.map((child) => child.taskId),
    ["task-1", "task-4"]
  );
  assert.deepEqual(host.startRequests[0].context.model, {
    id: "model",
    provider: "routed",
  });
  assert.equal(host.startRequests[0].context.thinkingLevel, "low");
  assert.equal(host.startRequests[0].rolePrompt, "Read only.");
  assert.equal(host.startRequests[1].context.thinkingLevel, "off");
  assert.equal(result.results[0].selection?.modelSource, "role");
  assert.equal(result.results[0].selection?.thinkingSource, "role");
  assert.equal(result.results[3].selection?.modelSource, "explicit");
  assert.equal(result.results[3].selection?.thinkingSource, "explicit");
  assert.deepEqual(result.results[4].selection, {
    thinkingLevel: "medium",
    thinkingSource: "default",
  });
  assert.doesNotMatch(
    JSON.stringify(result.results[4]),
    /private\/(?:first|model)|Private role/u
  );
});

void test("session cleanup closes tracked children but leaves uncertain occupants alone", async () => {
  const host = new FakeChildHost();
  const registry = new SessionChildRegistry();
  const first = await host.start({
    context: parentContext,
    parent: host.inspection,
    placement: "tab",
    sessionId: "one",
    taskId: taskIdFor(0),
  });
  const second = await host.start({
    context: parentContext,
    parent: host.inspection,
    placement: "tab",
    sessionId: "two",
    taskId: taskIdFor(1),
  });
  registry.add(first);
  registry.add(second);
  host.closeErrors.set(taskIdFor(1), new Error("occupant changed"));

  await registry.closeAll(host);

  assert.deepEqual(
    host.closed.map((child) => child.taskId),
    ["task-1"]
  );
});

void test("completes normally before the configured runtime timeout", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");

  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    {
      availableModels: [],
      config: { defaults: { timeoutSeconds: 1 }, roles: {} },
    }
  );

  assert.equal(result.results[0].status, "succeeded");
  assert.equal(result.results[0].elapsedMs, undefined);
  assert.equal(host.closed.length, 1);
});

void test("allows the global runtime timeout to be explicitly disabled", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  let settlePrompt: ((settlement: ChildSettlement) => void) | undefined;
  host.prompt = async () =>
    await new Promise<ChildSettlement>((resolve) => {
      settlePrompt = resolve;
    });
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    {
      availableModels: [],
      config: { defaults: { timeoutSeconds: false }, roles: {} },
    }
  );
  await flushMicrotasks();
  context.mock.timers.tick(600_000);
  await flushMicrotasks();

  assert.equal(host.closed.length, 0);
  assert.ok(settlePrompt !== undefined);
  settlePrompt({ status: "settled" });
  const result = await pending;

  assert.equal(result.results[0].status, "succeeded");
  assert.equal(result.results[0].elapsedMs, undefined);
  assert.equal(host.closed.length, 1);
});

void test("times out a child, aborts its prompt wait, and closes its pane", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  let promptAborted = false;
  host.prompt = async (_child, _prompt, signal) =>
    await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          promptAborted = true;
          reject(new Error("prompt wait aborted"));
        },
        { once: true }
      );
    });
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    {
      availableModels: [],
      config: { defaults: { timeoutSeconds: 1 }, roles: {} },
    }
  );
  await flushMicrotasks();
  context.mock.timers.tick(1000);
  const result = await pending;

  assert.equal(promptAborted, true);
  assert.equal(result.results[0].status, "timed_out");
  assert.equal(result.results[0].error?.code, "timed_out");
  assert.equal(result.results[0].elapsedMs, 1000);
  assert.equal(result.results[0].paneClosed, true);
  assert.equal(result.results[0].sessionPath, "/tmp/one.jsonl");
  assert.deepEqual(
    host.closed.map((child) => child.taskId),
    ["task-1"]
  );
});

void test("reports a timed-out pane as open when verified close fails", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.closeErrors.set(taskIdFor(0), new Error("occupant changed"));
  host.prompt = async (_child, _prompt, signal) =>
    await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    {
      availableModels: [],
      config: { defaults: { timeoutSeconds: 1 }, roles: {} },
    }
  );
  await flushMicrotasks();
  context.mock.timers.tick(1000);
  const result = await pending;

  assert.equal(result.results[0].status, "timed_out");
  assert.equal(result.results[0].paneClosed, false);
  assert.equal(host.closed.length, 0);
});

void test("stops waiting when verified pane closure does not settle", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.prompt = async (_child, _prompt, signal) =>
    await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  host.close = async (_child, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("close timed out"));
        },
        { once: true }
      );
    });
  };
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    {
      availableModels: [],
      config: { defaults: { timeoutSeconds: 1 }, roles: {} },
    }
  );
  await flushMicrotasks();
  context.mock.timers.tick(1000);
  await flushMicrotasks();
  context.mock.timers.tick(5000);
  const result = await pending;

  assert.equal(result.results[0].status, "timed_out");
  assert.equal(result.results[0].paneClosed, false);
});

void test("races concurrent child timeouts independently", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(1), "/tmp/two.jsonl");
  host.prompt = async (child, _taskPrompt, signal) => {
    if (child.taskId === "task-1") {
      return await new Promise<ChildSettlement>((resolve) => {
        setTimeout(() => {
          resolve({ status: "settled" });
        }, 500);
      });
    }
    return await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  };
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    {
      availableModels: [],
      config: { defaults: { timeoutSeconds: 1 }, roles: {} },
    }
  );
  await flushMicrotasks();
  context.mock.timers.tick(500);
  await flushMicrotasks();
  context.mock.timers.tick(500);
  const result = await pending;

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "timed_out"]
  );
  assert.deepEqual(
    host.closed.map((child) => child.taskId),
    ["task-1", "task-2"]
  );
});

void test("does not prompt a child when the Parent is already aborted", async () => {
  const host = new FakeChildHost();
  let prompted = false;
  host.prompt = async () => {
    await Promise.resolve();
    prompted = true;
    throw new Error("unexpected prompt");
  };
  const controller = new AbortController();
  controller.abort();

  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    { availableModels: [], config: { defaults: {}, roles: {} } },
    { signal: controller.signal }
  );

  assert.equal(result.results[0].status, "parent_aborted");
  assert.equal(prompted, false);
  assert.equal(host.closed.length, 0);
});

void test("parent abort closes a started child and preserves its session identity", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  const promptEvents = new EventTarget();
  const promptStarted = once(promptEvents, "started");
  let promptSignal: AbortSignal | undefined;
  host.prompt = async (_child, _prompt, signal) => {
    promptSignal = signal;
    promptEvents.dispatchEvent(new Event("started"));
    return await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("prompt wait aborted"));
        },
        { once: true }
      );
    });
  };
  const controller = new AbortController();
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    { availableModels: [], config: { defaults: {}, roles: {} } },
    { signal: controller.signal }
  );
  await promptStarted;
  controller.abort();
  const result = await pending;

  assert.equal(result.results[0].status, "parent_aborted");
  assert.equal(result.results[0].paneClosed, true);
  assert.ok(result.results[0].sessionId !== undefined);
  assert.equal(result.results[0].sessionPath, "/tmp/one.jsonl");
  assert.equal(promptSignal?.aborted, true);
  assert.deepEqual(
    host.closed.map((child) => child.taskId),
    ["task-1"]
  );
});

void test("parent abort leaves a started child open when verified close fails", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.closeErrors.set(taskIdFor(0), new Error("occupant changed"));
  const promptEvents = new EventTarget();
  const promptStarted = once(promptEvents, "started");
  host.prompt = async (_child, _prompt, signal) => {
    promptEvents.dispatchEvent(new Event("started"));
    return await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("prompt wait aborted"));
        },
        { once: true }
      );
    });
  };
  const controller = new AbortController();
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    { availableModels: [], config: { defaults: {}, roles: {} } },
    { signal: controller.signal }
  );
  await promptStarted;
  controller.abort();
  const result = await pending;

  assert.equal(result.results[0].status, "parent_aborted");
  assert.equal(result.results[0].paneClosed, false);
  assert.equal(result.results[0].sessionPath, "/tmp/one.jsonl");
  assert.equal(host.closed.length, 0);
});

void test("parent abort closes a verified child identified during startup", async () => {
  const host = new FakeChildHost();
  const startEvents = new EventTarget();
  const startEntered = once(startEvents, "entered");
  host.start = async (request, signal) => {
    startEvents.dispatchEvent(new Event("entered"));
    if (!signal) {
      throw new Error("missing Parent signal");
    }
    await once(signal, "abort");
    throw new StartChildError("startup aborted", {
      agentName: "pi_task_1",
      location: { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      sessionId: request.sessionId,
      sessionPath: "/tmp/one.jsonl",
      taskId: request.taskId,
      terminalId: "term-task-1",
    });
  };
  const controller = new AbortController();
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    { availableModels: [], config: { defaults: {}, roles: {} } },
    { signal: controller.signal }
  );
  await startEntered;
  controller.abort();
  const result = await pending;

  assert.equal(result.results[0].status, "parent_aborted");
  assert.equal(result.results[0].paneClosed, true);
  assert.ok(result.results[0].sessionId !== undefined);
  assert.equal(result.results[0].sessionPath, "/tmp/one.jsonl");
  assert.deepEqual(
    host.closed.map((child) => child.taskId),
    ["task-1"]
  );
});

void test("parent abort also closes a child that blocked before a sibling", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(1), "/tmp/two.jsonl");
  host.settlements.set(taskIdFor(0), { status: "blocked" });
  const promptEvents = new EventTarget();
  const secondPromptStarted = once(promptEvents, "second-started");
  const prompt = host.prompt.bind(host);
  host.prompt = async (child, taskPrompt, signal) => {
    if (child.taskId === "task-1") {
      return await prompt(child, taskPrompt, signal);
    }
    promptEvents.dispatchEvent(new Event("second-started"));
    return await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("prompt wait aborted"));
        },
        { once: true }
      );
    });
  };
  const controller = new AbortController();
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    { availableModels: [], config: { defaults: {}, roles: {} } },
    { signal: controller.signal }
  );
  await secondPromptStarted;
  await flushMicrotasks();
  controller.abort();
  const result = await pending;

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["blocked", "parent_aborted"]
  );
  assert.deepEqual(
    result.results.map((child) => child.paneClosed),
    [true, true]
  );
  assert.match(result.results[0].error?.message ?? "", /pane closed/u);
  assert.deepEqual(
    new Set(host.closed.map((child) => child.taskId)),
    new Set(["task-1", "task-2"])
  );
});

void test("parent abort attempts to close every concurrently started child", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(1), "/tmp/two.jsonl");
  const promptEvents = new EventTarget();
  const allPrompted = once(promptEvents, "all-started");
  let promptCount = 0;
  host.prompt = async (_child, _prompt, signal) => {
    promptCount += 1;
    if (promptCount === 2) {
      promptEvents.dispatchEvent(new Event("all-started"));
    }
    return await new Promise<ChildSettlement>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("prompt wait aborted"));
        },
        { once: true }
      );
    });
  };
  const controller = new AbortController();
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    { availableModels: [], config: { defaults: {}, roles: {} } },
    { signal: controller.signal }
  );
  await allPrompted;
  controller.abort();
  const result = await pending;

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["parent_aborted", "parent_aborted"]
  );
  assert.deepEqual(
    result.results.map((child) => child.paneClosed),
    [true, true]
  );
  assert.deepEqual(
    new Set(host.closed.map((child) => child.taskId)),
    new Set(["task-1", "task-2"])
  );
});
