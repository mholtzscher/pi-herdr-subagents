import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import test from "node:test";
import { ConcurrentBatchRunner } from "../../src/batch.js";
import { HerdrChildHost, SessionChildRegistry, StartChildError } from "../../src/herdr/host.js";
import type { ChildResultReader } from "../../src/results.js";
import { FakeChildHost, parentContext } from "../support/fake-child-host.js";
import { createFakeHerdrServer } from "../support/fake-herdr-server.js";

class Reader implements ChildResultReader {
  async read(input: { taskId: string }): Promise<{ summary: string; truncated: boolean }> {
    return { summary: `answer for ${input.taskId}`, truncated: false };
  }
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
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = await createFakeHerdrServer((request) => {
    calls.push(request as { method: string; params: Record<string, unknown> });
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "agent.start") return {};
    return { agent: { terminal_id: "term-1", agent_session: { kind: "path", value: "/missing.jsonl" } } };
  });
  try {
    const context = { ...parentContext, parentLabel: "Amber Finch" };
    await new HerdrChildHost().start({ taskId: "task-1" as never, placement: "tab", sessionId: "child", context, parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path } });
    await new HerdrChildHost().renameParent({ workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path }, context);
    const parentTab = calls.find((call) => call.method === "tab.rename");
    const tab = calls.find((call) => call.method === "tab.create");
    const pane = calls.find((call) => call.method === "pane.rename");
    const start = calls.find((call) => call.method === "agent.start");
    assert.equal(parentTab?.params.label, "Pi [amber-finch]");
    assert.equal(tab?.params.label, "Pi [amber-finch] task-1");
    assert.equal(pane?.params.label, "Pi [amber-finch] task-1");
    const args = start?.params.args as string[];
    assert.ok(args.includes("Pi [amber-finch] task-1"));
    assert.deepEqual(args.slice(-6), ["--exclude-tools", "spawn_pi", "--model", "openai/test", "--thinking", "low"]);
  } finally {
    await server.close();
  }
});

test("retries child startup until a newly created pane reaches its shell prompt", async () => {
  let startAttempts = 0;
  const server = await createFakeHerdrServer((request) => {
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "agent.start") {
      startAttempts += 1;
      if (startAttempts === 1) throw Object.assign(new Error("agent target pane w21:p9 is not an available shell"), { code: "agent_pane_busy" });
      return {};
    }
    return { agent: { terminal_id: "term-1", agent_session: { kind: "path", value: "/missing.jsonl" } } };
  });
  try {
    await new HerdrChildHost().start({
      taskId: "task-1" as never,
      placement: "tab",
      sessionId: "child",
      context: parentContext,
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    });
    assert.equal(startAttempts, 2);
  } finally {
    await server.close();
  }
});

test("passes selected role identity through a private temporary file", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let promptPath = "";
  let promptContents = "";
  let promptMode = 0;
  const server = await createFakeHerdrServer((request) => {
    calls.push(request as { method: string; params: Record<string, unknown> });
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "agent.start") {
      const args = (request.params as Record<string, unknown>).args as string[];
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
      taskId: "task-1" as never,
      placement: "tab",
      sessionId: "child",
      context: parentContext,
      rolePrompt: prompt,
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    });
    await pending;
    const args = calls.find((call) => call.method === "agent.start")?.params.args as string[];
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
    if (request.method === "tab.create") return { tab: { tab_id: "w21:t2" }, root_pane: { pane_id: "w21:p9" } };
    if (request.method === "agent.start") {
      const args = (request.params as Record<string, unknown>).args as string[];
      promptPath = args.at(-1) ?? "";
      throw new Error("start rejected");
    }
    return { agent: { terminal_id: "term-1" } };
  });
  try {
    await assert.rejects(() => new HerdrChildHost().start({
      taskId: "task-1" as never,
      placement: "tab",
      sessionId: "child",
      context: parentContext,
      rolePrompt: "Read only.",
      parent: { workspaceId: "w21", tabId: "w21:t1", paneId: "w21:p1", socketPath: server.path },
    }), /start rejected/);
    await assert.rejects(access(promptPath));
  } finally {
    await server.close();
  }
});

test("does not start children when the Parent tab cannot be renamed", async () => {
  const host = new FakeChildHost();
  host.renameError = new Error("tab rename rejected");

  const result = await new ConcurrentBatchRunner(host, new Reader()).run({ tasks: [{ prompt: "one" }, { prompt: "two" }] }, parentContext);

  assert.deepEqual(result.results.map((child) => child.status), ["failed", "failed"]);
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
    await assert.rejects(() => host.close({
      taskId: "task-1" as never,
      sessionId: "child",
      location: { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" },
      agentName: "pi_task_1",
      terminalId: "expected",
    }));
    assert.deepEqual(calls, ["agent.get"]);
  } finally {
    if (originalSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalSocketPath;
    await server.close();
  }
});

test("runs four children concurrently, preserves request order, and closes successes", async () => {
  const host = new FakeChildHost();
  for (let index = 1; index <= 4; index += 1) host.sessionPaths.set(`task-${index}` as never, `/tmp/${index}.jsonl`);
  const start = host.start.bind(host);
  const started = new Set<string>();
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  host.start = async (request) => {
    started.add(request.taskId);
    if (started.size === 4) release();
    await allStarted;
    return start(request);
  };
  const result = await new ConcurrentBatchRunner(host, new Reader()).run({
    tasks: [{ prompt: "one" }, { prompt: "two", placement: "split" }, { prompt: "three" }, { prompt: "four" }],
  }, parentContext);
  assert.deepEqual(result.results.map((child) => child.taskId), ["task-1", "task-2", "task-3", "task-4"]);
  assert.deepEqual(result.results.map((child) => child.status), ["succeeded", "succeeded", "succeeded", "succeeded"]);
  assert.equal(host.closed.length, 4);
  assert.deepEqual(host.parentLabels, ["Pi [w1-p1]"]);
});

test("preserves partial failures and blocked children without closing them", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set("task-1" as never, "/tmp/one.jsonl");
  host.promptErrors.set("task-2" as never, new Error("prompt rejected"));
  host.settlements.set("task-3" as never, { status: "blocked" });
  const result = await new ConcurrentBatchRunner(host, new Reader()).run({ tasks: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] }, parentContext);
  assert.deepEqual(result.results.map((child) => child.status), ["succeeded", "failed", "blocked"]);
  assert.equal(host.closed.length, 1);
  assert.equal(result.results[1].error?.code, "prompt_failed");
  assert.equal(result.results[2].error?.code, "blocked");
});

test("routes independent tasks while leaving route failures pane-free", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set("task-1" as never, "/tmp/one.jsonl");
  host.sessionPaths.set("task-4" as never, "/tmp/four.jsonl");
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
          explore: { prompt: "Read only.", model: "routed/model", thinking: "low" },
          unavailable: { prompt: "Private role.", model: "private/model" },
        },
      },
      availableModels: [{ provider: "routed", id: "model" }],
    },
  );

  assert.deepEqual(result.results.map((child) => child.status), ["succeeded", "failed", "failed", "succeeded", "failed"]);
  assert.deepEqual(result.results.map((child) => child.error?.code), [undefined, "role_not_found", "model_routing_failed", undefined, "model_routing_failed"]);
  assert.deepEqual(host.started.map((child) => child.taskId), ["task-1", "task-4"]);
  assert.deepEqual(host.startRequests[0].context.model, { provider: "routed", id: "model" });
  assert.equal(host.startRequests[0].context.thinkingLevel, "low");
  assert.equal(host.startRequests[0].rolePrompt, "Read only.");
  assert.equal(host.startRequests[1].context.thinkingLevel, "off");
  assert.equal(result.results[0].selection?.modelSource, "role");
  assert.equal(result.results[0].selection?.thinkingSource, "role");
  assert.equal(result.results[3].selection?.modelSource, "explicit");
  assert.equal(result.results[3].selection?.thinkingSource, "explicit");
  assert.deepEqual(result.results[4].selection, { thinkingLevel: "medium", thinkingSource: "default" });
  assert.doesNotMatch(JSON.stringify(result.results[4]), /private\/model|Private role/);
});

test("session cleanup closes tracked children but leaves uncertain occupants alone", async () => {
  const host = new FakeChildHost();
  const registry = new SessionChildRegistry();
  const first = await host.start({ taskId: "task-1" as never, placement: "tab", sessionId: "one", context: parentContext, parent: host.inspection });
  const second = await host.start({ taskId: "task-2" as never, placement: "tab", sessionId: "two", context: parentContext, parent: host.inspection });
  registry.add(first);
  registry.add(second);
  host.closeErrors.set("task-2" as never, new Error("occupant changed"));

  await registry.closeAll(host);

  assert.deepEqual(host.closed.map((child) => child.taskId), ["task-1"]);
});

test("parent abort leaves a started child open", async () => {
  const host = new FakeChildHost();
  host.sessionPaths.set("task-1" as never, "/tmp/one.jsonl");
  let resolvePrompt!: () => void;
  host.prompt = async () => new Promise((resolve) => { resolvePrompt = () => resolve({ status: "settled" }); });
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
