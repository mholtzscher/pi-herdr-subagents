import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ChildStatusLookup } from "../../src/cost.js";
import type { ChildRolesConfigLoadResult } from "../../src/model-routing.js";
import {
  findOrchestratorState,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_STATE_ENTRY,
  readOrchestratorState,
  registerOrchestrator,
} from "../../src/orchestrator.js";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}
interface OrchestratorStateData {
  enabled: boolean;
}
interface HarnessEvent {
  reason?: "new" | "resume" | "fork";
  previousSessionFile?: string;
  systemPrompt?: string;
}
interface HarnessContext {
  hasUI: boolean;
  sessionManager: { getEntries: () => SessionEntry[] };
  ui: {
    theme: { fg: (name: string, value: string) => string };
    setStatus: (key: string, value: string | undefined) => void;
    notify: (message: string, level?: string) => void;
  };
}
type Handler = (
  event: HarnessEvent,
  ctx: HarnessContext
) => { systemPrompt: string } | undefined;
interface Command {
  getArgumentCompletions?: (
    prefix: string
  ) => { label: string; value: string }[] | null;
  handler: (args: string, ctx: HarnessContext) => Promise<void>;
}

const noChildStatus: ChildStatusLookup = async () => {
  await Promise.resolve();
  return "open";
};

const harness = (
  configResult: ChildRolesConfigLoadResult,
  activeTools = ["spawn_pi"],
  lookupChildStatus: ChildStatusLookup = noChildStatus
) => {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const appended: { customType: string; data: OrchestratorStateData }[] = [];
  const notifications: { message: string; level?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  let sessionEntries: SessionEntry[] = [];
  const ctx: HarnessContext = {
    hasUI: true,
    sessionManager: { getEntries: () => sessionEntries },
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ level, message });
      },
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      theme: { fg: (_name: string, value: string) => value },
    },
  };
  // SAFETY: This test double provides every ExtensionAPI member registerOrchestrator invokes with behavior captured by this harness.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The harness implements only the ExtensionAPI members under test.
  const pi = {
    appendEntry(customType: string, data: OrchestratorStateData) {
      appended.push({ customType, data });
    },
    getActiveTools() {
      return activeTools;
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    setActiveTools(names: string[]) {
      activeTools.splice(0, activeTools.length, ...names);
    },
  } as ExtensionAPI;
  registerOrchestrator(pi, configResult, lookupChildStatus);
  const command = commands.get("orchestrator");
  if (!command) {
    throw new Error("orchestrator command was not registered");
  }
  return {
    appended,
    command,
    ctx,
    emit(name: string, event: HarnessEvent, context = ctx) {
      let result: ReturnType<Handler>;
      for (const handler of handlers.get(name) ?? []) {
        result = handler(event, context);
      }
      return result;
    },
    notifications,
    setEntries(entries: SessionEntry[]) {
      sessionEntries = entries;
    },
    statuses,
  };
};

const enabledConfig: ChildRolesConfigLoadResult = {
  config: { defaults: {}, orchestrator: { enabled: true }, roles: {} },
  ok: true,
  path: "/config.json",
};

const withParentEnvironment = async (
  run: () => Promise<void> | void
): Promise<void> => {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_TAB_ID: process.env.HERDR_TAB_ID,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  };
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "pane",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_TAB_ID: "tab",
    HERDR_WORKSPACE_ID: "workspace",
  });
  try {
    await run();
  } finally {
    if (previous.HERDR_ENV === undefined) {
      delete process.env.HERDR_ENV;
    } else {
      process.env.HERDR_ENV = previous.HERDR_ENV;
    }
    if (previous.HERDR_PANE_ID === undefined) {
      delete process.env.HERDR_PANE_ID;
    } else {
      process.env.HERDR_PANE_ID = previous.HERDR_PANE_ID;
    }
    if (previous.HERDR_SOCKET_PATH === undefined) {
      delete process.env.HERDR_SOCKET_PATH;
    } else {
      process.env.HERDR_SOCKET_PATH = previous.HERDR_SOCKET_PATH;
    }
    if (previous.HERDR_TAB_ID === undefined) {
      delete process.env.HERDR_TAB_ID;
    } else {
      process.env.HERDR_TAB_ID = previous.HERDR_TAB_ID;
    }
    if (previous.HERDR_WORKSPACE_ID === undefined) {
      delete process.env.HERDR_WORKSPACE_ID;
    } else {
      process.env.HERDR_WORKSPACE_ID = previous.HERDR_WORKSPACE_ID;
    }
  }
};

void test("finds the latest session-wide state and reads it from JSONL", () => {
  const entries = [
    {
      customType: ORCHESTRATOR_STATE_ENTRY,
      data: { enabled: true },
      type: "custom",
    },
    { customType: "other", data: { enabled: true }, type: "custom" },
    {
      customType: ORCHESTRATOR_STATE_ENTRY,
      data: { enabled: false },
      type: "custom",
    },
  ];
  assert.equal(findOrchestratorState(entries), false);

  const directory = mkdtempSync(path.join(tmpdir(), "orchestrator-"));
  const sessionPath = path.join(directory, "session.jsonl");
  try {
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "session" }),
        "malformed",
        ...entries.map((entry) => JSON.stringify(entry)),
      ].join("\n")
    );
    assert.equal(readOrchestratorState(sessionPath), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("uses the configured default, persists it, injects instructions, and toggles", async () => {
  await withParentEnvironment(async () => {
    const h = harness(enabledConfig);
    h.emit("session_start", { reason: "new" });
    assert.deepEqual(h.appended, [
      { customType: ORCHESTRATOR_STATE_ENTRY, data: { enabled: true } },
    ]);
    assert.equal(h.statuses.at(-1), "orchestrator");
    assert.deepEqual(h.emit("before_agent_start", { systemPrompt: "base" }), {
      systemPrompt: `base\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
    });

    await h.command.handler("off", h.ctx);
    assert.deepEqual(h.appended.at(-1), {
      customType: ORCHESTRATOR_STATE_ENTRY,
      data: { enabled: false },
    });
    assert.equal(
      h.emit("before_agent_start", { systemPrompt: "base" }),
      undefined
    );
    assert.deepEqual(h.notifications.at(-1), {
      level: "info",
      message: "○ Orchestrator disabled",
    });

    await h.command.handler("", h.ctx);
    assert.deepEqual(h.appended.at(-1), {
      customType: ORCHESTRATOR_STATE_ENTRY,
      data: { enabled: true },
    });
    assert.deepEqual(h.notifications.at(-1), {
      level: "info",
      message: "✓ Orchestrator enabled",
    });
  });
});

void test("disables spawn_pi when configured off and follows command toggles", async () => {
  await withParentEnvironment(async () => {
    const activeTools = ["read", "spawn_pi"];
    const h = harness(
      {
        ...enabledConfig,
        config: {
          ...enabledConfig.config,
          orchestrator: { enabled: false },
        },
      },
      activeTools
    );

    h.emit("session_start", { reason: "new" });
    assert.deepEqual(activeTools, ["read"]);

    await h.command.handler("on", h.ctx);
    assert.deepEqual(activeTools, ["read", "spawn_pi"]);

    await h.command.handler("off", h.ctx);
    assert.deepEqual(activeTools, ["read"]);
  });
});

void test("cost reports a snapshot while orchestrator mode is disabled or unavailable", async () => {
  await withParentEnvironment(async () => {
    const disabled = harness(enabledConfig);
    disabled.emit("session_start", { reason: "new" });
    await disabled.command.handler("off", disabled.ctx);
    await disabled.command.handler("cost", disabled.ctx);

    const expected = [
      "Orchestrator cost · current session",
      "",
      "Parent                              $0.0000",
      "Children  none",
      "Children subtotal                   $0.0000",
      "Total                               $0.0000",
    ].join("\n");
    assert.deepEqual(disabled.notifications.at(-1), {
      level: "info",
      message: expected,
    });
    assert.deepEqual(disabled.command.getArgumentCompletions?.("co"), [
      { label: "cost", value: "cost" },
    ]);

    const unavailable = harness(enabledConfig, []);
    unavailable.emit("session_start", { reason: "new" });
    await unavailable.command.handler("cost", unavailable.ctx);
    assert.deepEqual(unavailable.notifications.at(-1), {
      level: "info",
      message: expected,
    });
  });
});

void test("status reports configured Child Roles and descriptions", async () => {
  await withParentEnvironment(async () => {
    const h = harness({
      ...enabledConfig,
      config: {
        ...enabledConfig.config,
        roles: {
          explore: {
            description: "Read-only; reconnaissance.",
            prompt: "Inspect only.",
          },
          reviewer: { prompt: "Review changes." },
        },
      },
    });
    h.emit("session_start", { reason: "new" });

    await h.command.handler("status", h.ctx);

    assert.deepEqual(h.notifications.at(-1), {
      level: "info",
      message:
        "● Orchestrator enabled\n  Roles  explore (Read-only; reconnaissance.) · reviewer",
    });
  });
});

void test("status reports when no Child Roles are configured", async () => {
  await withParentEnvironment(async () => {
    const h = harness(enabledConfig);
    h.emit("session_start", { reason: "new" });
    await h.command.handler("off", h.ctx);

    await h.command.handler("status", h.ctx);

    assert.deepEqual(h.notifications.at(-1), {
      level: "info",
      message: "○ Orchestrator disabled\n  Roles  none",
    });
  });
});

void test("restores state across branches and forks inherit the source session current state", async () => {
  await withParentEnvironment(() => {
    const directory = mkdtempSync(path.join(tmpdir(), "orchestrator-fork-"));
    const source = path.join(directory, "source.jsonl");
    try {
      writeFileSync(
        source,
        [
          JSON.stringify({ type: "session" }),
          JSON.stringify({
            customType: ORCHESTRATOR_STATE_ENTRY,
            data: { enabled: false },
            type: "custom",
          }),
          JSON.stringify({
            customType: ORCHESTRATOR_STATE_ENTRY,
            data: { enabled: true },
            type: "custom",
          }),
        ].join("\n")
      );
      const h = harness({
        ...enabledConfig,
        config: { ...enabledConfig.config, orchestrator: { enabled: false } },
      });
      h.setEntries([
        {
          customType: ORCHESTRATOR_STATE_ENTRY,
          data: { enabled: false },
          type: "custom",
        },
      ]);
      h.emit("session_start", { previousSessionFile: source, reason: "fork" });
      assert.deepEqual(h.appended.at(-1), {
        customType: ORCHESTRATOR_STATE_ENTRY,
        data: { enabled: true },
      });
      assert.deepEqual(h.emit("before_agent_start", { systemPrompt: "base" }), {
        systemPrompt: `base\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

void test("hands current state to in-memory forks", async () => {
  await withParentEnvironment(async () => {
    const source = harness({
      ...enabledConfig,
      config: { ...enabledConfig.config, orchestrator: { enabled: false } },
    });
    source.emit("session_start", { reason: "new" });
    await source.command.handler("on", source.ctx);
    source.emit("session_before_fork", {});

    const fork = harness({
      ...enabledConfig,
      config: { ...enabledConfig.config, orchestrator: { enabled: false } },
    });
    fork.emit("session_start", { reason: "fork" });
    assert.deepEqual(fork.appended.at(-1), {
      customType: ORCHESTRATOR_STATE_ENTRY,
      data: { enabled: true },
    });
  });
});

void test("keeps enabled preference while spawn_pi is temporarily inactive", async () => {
  await withParentEnvironment(() => {
    const activeTools = ["spawn_pi"];
    const h = harness(enabledConfig, activeTools);
    h.setEntries([
      {
        customType: ORCHESTRATOR_STATE_ENTRY,
        data: { enabled: true },
        type: "custom",
      },
    ]);
    h.emit("session_start", { reason: "resume" });
    activeTools.splice(0);
    assert.equal(
      h.emit("before_agent_start", { systemPrompt: "base" }),
      undefined
    );
    activeTools.push("spawn_pi");
    assert.deepEqual(h.emit("before_agent_start", { systemPrompt: "base" }), {
      systemPrompt: `base\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
    });
  });
});

void test("disables and persists while spawn_pi is inactive", async () => {
  await withParentEnvironment(async () => {
    const activeTools = ["spawn_pi"];
    const h = harness(enabledConfig, activeTools);
    h.setEntries([
      {
        customType: ORCHESTRATOR_STATE_ENTRY,
        data: { enabled: true },
        type: "custom",
      },
    ]);
    h.emit("session_start", { reason: "resume" });
    activeTools.splice(0);

    await h.command.handler("off", h.ctx);
    assert.deepEqual(h.appended.at(-1), {
      customType: ORCHESTRATOR_STATE_ENTRY,
      data: { enabled: false },
    });

    activeTools.push("spawn_pi");
    assert.equal(
      h.emit("before_agent_start", { systemPrompt: "base" }),
      undefined
    );
  });
});

void test("reports invalid command usage", async () => {
  await withParentEnvironment(async () => {
    const h = harness(enabledConfig);
    h.emit("session_start", { reason: "new" });

    await h.command.handler("invalid", h.ctx);

    assert.deepEqual(h.notifications.at(-1), {
      level: "error",
      message: "! Usage: /orchestrator [on|off|status|cost|toggle]",
    });
  });
});

void test("keeps the mode unavailable in children, outside Herdr, and with invalid config", async () => {
  await withParentEnvironment(async () => {
    const child = harness(enabledConfig, []);
    child.emit("session_start", { reason: "new" });
    assert.equal(
      child.emit("before_agent_start", { systemPrompt: "base" }),
      undefined
    );
    await child.command.handler("status", child.ctx);
    assert.deepEqual(child.notifications.at(-1), {
      level: "warning",
      message:
        "△ Orchestrator unavailable\n  Requires a Herdr Parent with spawn_pi active.",
    });

    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    const outside = harness(enabledConfig);
    outside.emit("session_start", { reason: "new" });
    await outside.command.handler("on", outside.ctx);
    assert.deepEqual(outside.notifications.at(-1), {
      level: "warning",
      message:
        "△ Orchestrator unavailable\n  Requires a Herdr Parent with spawn_pi active.",
    });

    const invalid = harness({
      error: "orchestrator.enabled must be a boolean",
      ok: false,
      path: "/bad.json",
    });
    invalid.emit("session_start", { reason: "new" });
    assert.deepEqual(invalid.notifications.at(-1), {
      level: "warning",
      message:
        "! Orchestrator disabled — invalid config\n  /bad.json\n  orchestrator.enabled must be a boolean\n  spawn_pi blocked",
    });
    assert.equal(
      invalid.emit("before_agent_start", { systemPrompt: "base" }),
      undefined
    );
  });
});
