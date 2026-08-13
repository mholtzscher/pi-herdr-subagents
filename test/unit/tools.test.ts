import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BatchRunner } from "../../src/batch.js";
import type { ChildResult } from "../../src/domain.js";
import { registerSpawnPiTool } from "../../src/tools.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function registeredTool(): any {
  let tool: any;
  registerSpawnPiTool(
    {
      registerTool(definition: unknown) {
        tool = definition;
      },
    } as ExtensionAPI,
    {} as BatchRunner,
    () => "parent",
    { ok: true, path: "/config.json", config: { orchestrator: { enabled: false }, defaults: {}, roles: {} } },
  );
  return tool;
}

function child(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    taskId: "task-1" as never,
    requestIndex: 0,
    status: "succeeded",
    truncated: false,
    paneClosed: true,
    ...overrides,
  };
}

function render(tool: any, details: unknown, args: unknown, expanded = false, isPartial = false): string {
  return tool
    .renderResult({ details, content: [{ type: "text", text: "raw text" }] }, { expanded, isPartial }, theme, { args })
    .render(500)
    .join("\n")
    .replace(/ +\n/g, "\n")
    .trimEnd();
}

test("renders a stable partial card with every requested task in request order", () => {
  const tool = registeredTool();
  const output = render(
    tool,
    {
      phase: "working",
      progress: {
        completed: 1,
        total: 3,
        results: [
          child({
            requestIndex: 1,
            taskId: "task-2" as never,
            status: "blocked",
            paneClosed: false,
            location: { workspaceId: "w", tabId: "tab-5", paneId: "pane-2" },
          }),
        ],
      },
    },
    {
      tasks: [{ prompt: "one", role: "explore\n\u001b[31m" }, { prompt: "two", role: "reviewer" }, { prompt: "three" }],
    },
    false,
    true,
  );

  assert.match(output, /^working · 1 of 3 settled/);
  assert.match(output, /◌ task-1 \[explore \[31m\] working/);
  assert.match(output, /! task-2 \[reviewer\] needs input · tab-5\/pane-2/);
  assert.match(output, /◌ task-3 working/);
});

test("renders collapsed and expanded final rows with the approved visibility policy", () => {
  const tool = registeredTool();
  const result = {
    requested: 3,
    results: [
      child({
        summary: "finished",
        truncated: true,
        sessionId: "session-1",
        selection: {
          model: { provider: "openai", id: "model" },
          modelSource: "role",
          thinkingLevel: "low",
          thinkingSource: "default",
        },
      }),
      child({
        taskId: "task-2" as never,
        requestIndex: 1,
        status: "blocked",
        paneClosed: false,
        location: { workspaceId: "w", tabId: "tab-2", paneId: "pane-3" },
        error: { code: "blocked", message: "Please choose" },
      }),
      child({
        taskId: "task-3" as never,
        requestIndex: 2,
        status: "failed",
        error: { code: "model_routing_failed", message: "No configured model is available" },
      }),
    ],
  };
  const args = {
    tasks: [{ prompt: "one", role: "explore" }, { prompt: "two", role: "reviewer" }, { prompt: "three" }],
  };
  const collapsed = render(tool, { phase: "finished", result }, args);
  const expanded = render(tool, { phase: "finished", result }, args, true);

  assert.match(collapsed, /^incomplete · 1 of 3 complete/);
  assert.match(collapsed, /✓ task-1 \[explore\] complete/);
  assert.doesNotMatch(collapsed, /session-1|openai\/model|finished|Please choose/);
  assert.match(collapsed, /! task-2 \[reviewer\] needs input · tab-2\/pane-3/);
  assert.match(collapsed, /× task-3 incomplete · model unavailable/);
  assert.match(
    expanded,
    /finished\nsummary truncated\nmodel: openai\/model\nthinking: low\nmodel selection: role\nthinking selection: default\nsession: session-1/,
  );
  assert.match(expanded, /Please choose/);
});

test("supports legacy final details and safely falls back to raw content", () => {
  const tool = registeredTool();
  const legacy = {
    requested: 1,
    results: [child({ status: "failed", error: { code: "start_failed", message: "broken" } })],
  };

  assert.match(render(tool, legacy, { tasks: [{ prompt: "one" }] }), /^incomplete · 0 of 1 complete/);
  assert.equal(render(tool, undefined, { tasks: [{ prompt: "one" }] }), "raw text");
  assert.equal(render(tool, legacy, { tasks: [{ prompt: "one" }] }, false, true), "raw text");
  assert.equal(tool.renderCall({}, theme).render(500).join("\n").trimEnd(), "spawn_pi");
  assert.equal(
    tool
      .renderCall({ tasks: [{ prompt: "one" }] }, theme)
      .render(500)
      .join("\n")
      .trimEnd(),
    "spawn_pi 1 task",
  );
});
