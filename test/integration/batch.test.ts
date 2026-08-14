import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import test from "node:test";
import { ConcurrentBatchRunner } from "../../src/batch.js";
import { taskIdFor, type BatchProgress } from "../../src/domain.js";
import { HerdrChildHost, SessionChildRegistry, StartChildError } from "../../src/herdr/host.js";
import type { ChildResultReader } from "../../src/results.js";
import { FakeChildHost, parentContext } from "../support/fake-child-host.js";
import { createFakeHerdrServer } from "../support/fake-herdr-server.js";

class Reader implements ChildResultReader {
  async read(input: { taskId: string }): Promise<{ summary: string; truncated: boolean }> {
    return { summary: `answer for ${input.taskId}`, truncated: false };
  }
}

type CapturedHerdrCall = {
  method: string;
  params: { args?: string[]; label?: string };
};

function captureHerdrCall(request: { method: string; params: unknown }): CapturedHerdrCall {
  // SAFETY: The fake server invokes this only with requests emitted by the HerdrChildHost under test.
  return request as CapturedHerdrCall;
}

function readyShell() {
  return { process_info: { shell_pid: 101, foreground_processes: [{ pid: 101 }] } };
}

test("rejects spawn outside a Herdr Parent pane without crashing", async () => {
  const original = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try {
    await assert.rejects(() => new HerdrChildHost().inspect(), /HERDR_ENV=1/);
  } finally {
    if (original === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = original;
  }
});

test("labels the Parent tab and every visible child surface with its readable Parent identity", async () => {
  const calls: CapturedHerdrCall[] = [];
  const server = await createFakeHerdrServer((request) => {
    calls.push(captureHerdrCall(request));
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "pane.process_info") return readyShell();
    if (request.method === "agent.start") return {};
    return { agent: { terminal_id: "term-1", agent_session: { kind: "path", value: "/missing.jsonl" } } };
  });
  try {
    const context = { ...parentContext, parentLabel: "Amber Finch" };
    await new HerdrChildHost().start({
      taskId: taskIdFor(0),
      placement: "tab",
      sessionId: "child",
      context,
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    });
    await new HerdrChildHost().renameParent(
      { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
      context,
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
    assert.ok(args.includes("--entire-nested"));
    assert.deepEqual(args.slice(-6), ["--exclude-tools", "spawn_pi", "--model", "openai/test", "--thinking", "low"]);
  } finally {
    await server.close();
  }
});

test("retries child startup until the pane and its shell are ready", async () => {
  const readinessErrors = [
    Object.assign(new Error("agent target pane w21:p9 not found"), { code: "agent_pane_not_found" }),
    Object.assign(new Error("agent target pane w21:p9 has no live terminal"), { code: "agent_pane_unavailable" }),
    Object.assign(new Error("agent target pane w21:p9 is not an available shell"), { code: "agent_pane_busy" }),
  ];
  let startAttempts = 0;
  let processPolls = 0;
  const controller = new AbortController();
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "pane.process_info") {
      processPolls += 1;
      return readyShell();
    }
    if (request.method === "agent.start") {
      const error = readinessErrors[startAttempts];
      startAttempts += 1;
      if (error) throw error;
      return {};
    }
    return { agent: { terminal_id: "term-1", agent_session: { kind: "path", value: "/missing.jsonl" } } };
  });
  try {
    await new HerdrChildHost().start(
      {
        taskId: taskIdFor(0),
        placement: "tab",
        sessionId: "child",
        context: parentContext,
        parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
      },
      controller.signal,
    );
    assert.equal(startAttempts, 4);
    assert.equal(processPolls, 12);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await server.close();
  }
});

test("waits for a stable foreground shell before starting a child", async () => {
  const foregroundPids = [101, 202, 101, 101, 101];
  let processAttempts = 0;
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "pane.process_info") {
      processAttempts += 1;
      if (processAttempts === 1) throw Object.assign(new Error("pane not found"), { code: "pane_not_found" });
      const pid = foregroundPids.shift();
      assert.notEqual(pid, undefined);
      return { process_info: { shell_pid: 101, foreground_processes: [{ pid }] } };
    }
    if (request.method === "agent.start") {
      assert.equal(foregroundPids.length, 0);
      return {};
    }
    return { agent: { terminal_id: "term-1", agent_session: { kind: "path", value: "/missing.jsonl" } } };
  });
  try {
    await new HerdrChildHost().start({
      taskId: taskIdFor(0),
      placement: "tab",
      sessionId: "child",
      context: parentContext,
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    });
    assert.equal(processAttempts, 6);
  } finally {
    await server.close();
  }
});

test("polls through a null child session until Herdr reports its path", async () => {
  let sessionPolls = 0;
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "pane.process_info") return readyShell();
    if (request.method === "agent.start") return {};
    if (request.method === "agent.get") {
      sessionPolls += 1;
      return {
        agent: {
          terminal_id: "term-1",
          agent_session: sessionPolls === 1 ? null : { kind: "path", value: "/missing.jsonl" },
        },
      };
    }
    return {};
  });
  try {
    const child = await new HerdrChildHost().start({
      taskId: taskIdFor(0),
      placement: "tab",
      sessionId: "child",
      context: parentContext,
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    });
    assert.equal(sessionPolls, 2);
    assert.equal(child.sessionPath, "/missing.jsonl");
  } finally {
    await server.close();
  }
});

test("passes selected role identity through a private temporary file", async () => {
  const calls: CapturedHerdrCall[] = [];
  let promptPath = "";
  let promptContents = "";
  let promptMode = 0;
  const server = await createFakeHerdrServer((request) => {
    const call = captureHerdrCall(request);
    calls.push(call);
    if (call.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (call.method === "pane.process_info") return readyShell();
    if (call.method === "agent.start") {
      const args = call.params.args;
      assert.ok(args);
      promptPath = args.at(-1) ?? "";
      promptContents = readFileSync(promptPath, "utf8");
      promptMode = statSync(promptPath).mode;
      return {};
    }
    return { agent: { terminal_id: "term-1", agent_session: { kind: "path", value: "/missing.jsonl" } } };
  });
  try {
    const prompt = "Read only.\n\nPreserve 'quotes' and $variables.";
    const pending = new HerdrChildHost().start({
      taskId: taskIdFor(0),
      placement: "tab",
      sessionId: "child",
      context: parentContext,
      rolePrompt: prompt,
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    });
    await pending;
    const args = calls.find((call) => call.method === "agent.start")?.params.args;
    assert.ok(args);
    promptPath = args.at(-1) ?? "";
    assert.equal(args.at(-2), "--append-system-prompt");
    assert.doesNotMatch(promptPath, /[\r\n]/);
    await assert.rejects(access(promptPath));

    assert.equal(promptContents, `Child role instructions:\n${prompt}`);
    assert.equal(promptMode & 0o777, 0o600);
  } finally {
    await server.close();
  }
});

test("removes the temporary role prompt when child startup fails", async () => {
  let promptPath = "";
  const server = await createFakeHerdrServer((request) => {
    const call = captureHerdrCall(request);
    if (call.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (call.method === "pane.process_info") return readyShell();
    if (call.method === "agent.start") {
      const args = call.params.args;
      assert.ok(args);
      promptPath = args.at(-1) ?? "";
      throw new Error("start rejected");
    }
    return { agent: { terminal_id: "term-1" } };
  });
  try {
    await assert.rejects(
      () =>
        new HerdrChildHost().start({
          taskId: taskIdFor(0),
          placement: "tab",
          sessionId: "child",
          context: parentContext,
          rolePrompt: "Read only.",
          parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
        }),
      /start rejected/,
    );
    await assert.rejects(access(promptPath));
  } finally {
    await server.close();
  }
});

test("does not start children when the Parent tab cannot be renamed", async () => {
  const host = new FakeChildHost();
  host.renameError = new Error("tab rename rejected");
  const snapshots: BatchProgress[] = [];

  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    undefined,
    { onProgress: (snapshot) => snapshots.push(snapshot) },
  );

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["failed", "failed"],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.results.length),
    [0, 2],
  );
  assert.equal(host.started.length, 0);
  assert.deepEqual(host.parentLabels, []);
});

test("retains the known child location when startup fails after creation", async () => {
  const host = new FakeChildHost();
  host.start = async (request) => {
    throw new StartChildError("Pi did not register", {
      taskId: request.taskId,
      sessionId: request.sessionId,
      location: { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" },
      agentName: "pi_task_1",
      terminalId: "term-1",
    });
  };

  const result = await new ConcurrentBatchRunner(host, new Reader()).run({ tasks: [{ prompt: "one" }] }, parentContext);

  assert.equal(result.results[0].status, "failed");
  assert.deepEqual(result.results[0].location, { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" });
  assert.ok(result.results[0].sessionId);
});

test("does not close a pane whose Herdr occupant changed", async () => {
  const calls: string[] = [];
  const server = await createFakeHerdrServer((request) => {
    calls.push(request.method);
    return { agent: { pane_id: "w1:p2", terminal_id: "replacement" } };
  });
  const originalSocketPath = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = server.path;
  try {
    const host = new HerdrChildHost();
    await assert.rejects(() =>
      host.close({
        taskId: taskIdFor(0),
        sessionId: "child",
        location: { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" },
        agentName: "pi_task_1",
        terminalId: "expected",
      }),
    );
    assert.deepEqual(calls, ["agent.get"]);
  } finally {
    if (originalSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalSocketPath;
    await server.close();
  }
});

test("runs four children concurrently, preserves request order, and closes successes", async () => {
  const host = new FakeChildHost();
  for (let index = 1; index <= 4; index += 1) host.sessionPaths.set(taskIdFor(index - 1), `/tmp/${index}.jsonl`);
  const start = host.start.bind(host);
  const started = new Set<string>();
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.start = async (request) => {
    started.add(request.taskId);
    if (started.size === 4) release();
    await allStarted;
    return start(request);
  };
  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    {
      tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }, { prompt: "four" }],
    },
    parentContext,
  );
  assert.deepEqual(
    result.results.map((child) => child.taskId),
    ["task-1", "task-2", "task-3", "task-4"],
  );
  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "succeeded", "succeeded", "succeeded"],
  );
  assert.equal(host.closed.length, 4);
  assert.deepEqual(
    host.startRequests.map((request) => request.placement),
    ["tab", "tab", "tab", "tab"],
  );
  assert.deepEqual(host.parentLabels, ["Pi [w1-p1]"]);
});

test("uses one configured placement for every child and falls back to tab", async () => {
  for (const [placement, expected] of [
    [undefined, "tab"],
    ["tab", "tab"],
    ["split", "split"],
  ] as const) {
    const host = new FakeChildHost();
    await new ConcurrentBatchRunner(host, new Reader()).run(
      { tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] },
      parentContext,
      {
        config: { defaults: placement === undefined ? {} : { placement }, roles: {} },
        availableModels: [],
      },
    );
    assert.deepEqual(
      host.startRequests.map((request) => request.placement),
      [expected, expected, expected],
    );
  }
});

test("emits immutable request-ordered progress snapshots from initial through final settlement", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(1), "/tmp/two.jsonl");
  const prompt = host.prompt.bind(host);
  let releaseFirst!: () => void;
  let secondSettled!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondComplete = new Promise<void>((resolve) => {
    secondSettled = resolve;
  });
  host.prompt = async (child, taskPrompt) => {
    if (child.taskId === "task-1") await firstPending;
    else secondSettled();
    return prompt(child, taskPrompt);
  };
  const snapshots: BatchProgress[] = [];
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    parentContext,
    undefined,
    { onProgress: (snapshot) => snapshots.push(snapshot) },
  );

  await secondComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirst();
  const result = await pending;

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.results.map((child) => child.taskId)),
    [[], ["task-2"], ["task-1", "task-2"]],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.completed),
    [0, 1, 2],
  );
  assert.notStrictEqual(snapshots[0].results, snapshots[1].results);
  assert.notStrictEqual(snapshots[1].results, snapshots[2].results);
  assert.strictEqual(snapshots[2].results[0], result.results[0]);
  assert.strictEqual(snapshots[2].results[1], result.results[1]);
});

test("preserves partial failures and blocked children without closing them", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.promptErrors.set(taskIdFor(1), new Error("prompt rejected"));
  host.settlements.set(taskIdFor(2), { status: "blocked" });
  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] },
    parentContext,
  );
  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "failed", "blocked"],
  );
  assert.equal(host.closed.length, 1);
  assert.equal(result.results[1].error?.code, "prompt_failed");
  assert.equal(result.results[2].error?.code, "blocked");
});

test("routes independent tasks while leaving route failures pane-free", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  host.sessionPaths.set(taskIdFor(3), "/tmp/four.jsonl");
  const result = await new ConcurrentBatchRunner(host, new Reader()).run(
    {
      tasks: [
        { prompt: "one", role: "explore" },
        { prompt: "two", role: "missing" },
        { prompt: "three", model: "missing/model" },
        { prompt: "four", model: "routed/model", thinking: "off" },
        { prompt: "five", role: "unavailable" },
      ],
    },
    parentContext,
    {
      config: {
        defaults: { thinking: "medium" },
        roles: {
          explore: { prompt: "Read only.", model: ["missing/model", "routed/model"], thinking: "low" },
          unavailable: { prompt: "Private role.", model: ["private/first", "private/model"] },
        },
      },
      availableModels: [{ provider: "routed", id: "model" }],
    },
  );

  assert.deepEqual(
    result.results.map((child) => child.status),
    ["succeeded", "failed", "failed", "succeeded", "failed"],
  );
  assert.deepEqual(
    result.results.map((child) => child.error?.code),
    [undefined, "role_not_found", "model_routing_failed", undefined, "model_routing_failed"],
  );
  assert.deepEqual(
    host.started.map((child) => child.taskId),
    ["task-1", "task-4"],
  );
  assert.deepEqual(host.startRequests[0].context.model, { provider: "routed", id: "model" });
  assert.equal(host.startRequests[0].context.thinkingLevel, "low");
  assert.equal(host.startRequests[0].rolePrompt, "Read only.");
  assert.equal(host.startRequests[1].context.thinkingLevel, "off");
  assert.equal(result.results[0].selection?.modelSource, "role");
  assert.equal(result.results[0].selection?.thinkingSource, "role");
  assert.equal(result.results[3].selection?.modelSource, "explicit");
  assert.equal(result.results[3].selection?.thinkingSource, "explicit");
  assert.deepEqual(result.results[4].selection, { thinkingLevel: "medium", thinkingSource: "default" });
  assert.doesNotMatch(JSON.stringify(result.results[4]), /private\/(first|model)|Private role/);
});

test("session cleanup closes tracked children but leaves uncertain occupants alone", async () => {
  const host = new FakeChildHost();
  const registry = new SessionChildRegistry();
  const first = await host.start({
    taskId: taskIdFor(0),
    placement: "tab",
    sessionId: "one",
    context: parentContext,
    parent: host.inspection,
  });
  const second = await host.start({
    taskId: taskIdFor(1),
    placement: "tab",
    sessionId: "two",
    context: parentContext,
    parent: host.inspection,
  });
  registry.add(first);
  registry.add(second);
  host.closeErrors.set(taskIdFor(1), new Error("occupant changed"));

  await registry.closeAll(host);

  assert.deepEqual(
    host.closed.map((child) => child.taskId),
    ["task-1"],
  );
});

test("parent abort leaves a started child open", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set(taskIdFor(0), "/tmp/one.jsonl");
  let resolvePrompt!: () => void;
  host.prompt = async () =>
    new Promise((resolve) => {
      resolvePrompt = () => resolve({ status: "settled" });
    });
  const controller = new AbortController();
  const pending = new ConcurrentBatchRunner(host, new Reader()).run(
    { tasks: [{ prompt: "one" }] },
    parentContext,
    { config: { defaults: {}, roles: {} }, availableModels: [] },
    { signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const result = await pending;
  resolvePrompt();
  assert.equal(result.results[0].status, "parent_aborted");
  assert.equal(host.closed.length, 0);
});
