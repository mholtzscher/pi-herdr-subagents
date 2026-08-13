import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findOrchestratorState,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_STATE_ENTRY,
  readOrchestratorState,
  registerOrchestrator,
} from "../../src/orchestrator.js";
import type { ChildRolesConfigLoadResult } from "../../src/model-routing.js";

type Handler = (event: any, ctx: any) => any;

function harness(configResult: ChildRolesConfigLoadResult, activeTools = ["spawn_pi"]) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    getActiveTools() {
      return activeTools;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: { getEntries: () => [] },
    ui: {
      theme: { fg: (_name: string, value: string) => value },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  };
  registerOrchestrator(pi, configResult);
  return {
    handlers,
    command: commands.get("orchestrator"),
    appended,
    notifications,
    statuses,
    ctx,
    emit(name: string, event: unknown, context = ctx) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = handler(event, context);
      return result;
    },
  };
}

const enabledConfig: ChildRolesConfigLoadResult = {
  ok: true,
  path: "/config.json",
  config: { orchestrator: { enabled: true }, defaults: {}, roles: {} },
};

const HERDR_KEYS = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const;

function withParentEnvironment(run: () => void | Promise<void>): Promise<void> {
  const previous = Object.fromEntries(HERDR_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "workspace",
    HERDR_TAB_ID: "tab",
    HERDR_PANE_ID: "pane",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  });
  return Promise.resolve(run()).finally(() => {
    for (const key of HERDR_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("finds the latest session-wide state and reads it from JSONL", () => {
  const entries = [
    { type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } },
    { type: "custom", customType: "other", data: { enabled: true } },
    { type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: false } },
  ];
  assert.equal(findOrchestratorState(entries), false);

  const directory = mkdtempSync(join(tmpdir(), "orchestrator-"));
  const path = join(directory, "session.jsonl");
  try {
    writeFileSync(
      path,
      [JSON.stringify({ type: "session" }), "malformed", ...entries.map((entry) => JSON.stringify(entry))].join("\n"),
    );
    assert.equal(readOrchestratorState(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses the configured default, persists it, injects instructions, and toggles", async () => {
  await withParentEnvironment(async () => {
    const h = harness(enabledConfig);
    h.emit("session_start", { reason: "new" });
    assert.deepEqual(h.appended, [{ customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } }]);
    assert.equal(h.statuses.at(-1), "orchestrator");
    assert.deepEqual(h.emit("before_agent_start", { systemPrompt: "base" }), {
      systemPrompt: `base\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
    });

    await h.command.handler("off", h.ctx);
    assert.deepEqual(h.appended.at(-1), { customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: false } });
    assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
    assert.match(h.notifications.at(-1)?.message ?? "", /disabled/);

    await h.command.handler("", h.ctx);
    assert.deepEqual(h.appended.at(-1), { customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } });
  });
});

test("restores state across branches and forks inherit the source session current state", async () => {
  await withParentEnvironment(() => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-fork-"));
    const source = join(directory, "source.jsonl");
    try {
      writeFileSync(
        source,
        [
          JSON.stringify({ type: "session" }),
          JSON.stringify({ type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: false } }),
          JSON.stringify({ type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } }),
        ].join("\n"),
      );
      const h = harness({ ...enabledConfig, config: { ...enabledConfig.config, orchestrator: { enabled: false } } });
      (h.ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
        { type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: false } },
      ];
      h.emit("session_start", { reason: "fork", previousSessionFile: source });
      assert.deepEqual(h.appended.at(-1), { customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } });
      assert.deepEqual(h.emit("before_agent_start", { systemPrompt: "base" }), {
        systemPrompt: `base\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("hands current state to in-memory forks", async () => {
  await withParentEnvironment(async () => {
    const source = harness({ ...enabledConfig, config: { ...enabledConfig.config, orchestrator: { enabled: false } } });
    source.emit("session_start", { reason: "new" });
    await source.command.handler("on", source.ctx);
    source.emit("session_before_fork", {});

    const fork = harness({ ...enabledConfig, config: { ...enabledConfig.config, orchestrator: { enabled: false } } });
    fork.emit("session_start", { reason: "fork" });
    assert.deepEqual(fork.appended.at(-1), { customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } });
  });
});

test("keeps enabled preference while spawn_pi is temporarily inactive", async () => {
  await withParentEnvironment(async () => {
    const activeTools: string[] = [];
    const h = harness(enabledConfig, activeTools);
    (h.ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
      { type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } },
    ];
    h.emit("session_start", { reason: "resume" });
    assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
    activeTools.push("spawn_pi");
    assert.deepEqual(h.emit("before_agent_start", { systemPrompt: "base" }), {
      systemPrompt: `base\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
    });
  });
});

test("disables and persists while spawn_pi is inactive", async () => {
  await withParentEnvironment(async () => {
    const activeTools: string[] = [];
    const h = harness(enabledConfig, activeTools);
    (h.ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
      { type: "custom", customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } },
    ];
    h.emit("session_start", { reason: "resume" });

    await h.command.handler("off", h.ctx);
    assert.deepEqual(h.appended.at(-1), { customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: false } });

    activeTools.push("spawn_pi");
    assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  });
});

test("keeps the mode unavailable in children, outside Herdr, and with invalid config", async () => {
  await withParentEnvironment(async () => {
    const child = harness(enabledConfig, []);
    child.emit("session_start", { reason: "new" });
    assert.equal(child.emit("before_agent_start", { systemPrompt: "base" }), undefined);
    await child.command.handler("on", child.ctx);
    assert.match(child.notifications.at(-1)?.message ?? "", /Herdr Parent/);

    for (const key of HERDR_KEYS) delete process.env[key];
    const outside = harness(enabledConfig);
    outside.emit("session_start", { reason: "new" });
    await outside.command.handler("on", outside.ctx);
    assert.match(outside.notifications.at(-1)?.message ?? "", /Herdr Parent/);

    const invalid = harness({ ok: false, path: "/bad.json", error: "orchestrator.enabled must be a boolean" });
    invalid.emit("session_start", { reason: "new" });
    assert.match(invalid.notifications.at(-1)?.message ?? "", /Invalid config at \/bad.json/);
    assert.equal(invalid.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  });
});
