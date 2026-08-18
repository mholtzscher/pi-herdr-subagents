import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BatchRunner } from "../../src/batch.js";
import type {
  BatchProgress,
  ChildResult,
  SpawnBatchResult,
  SpawnTask,
} from "../../src/domain.js";
import { taskIdFor } from "../../src/domain.js";
import { registerSpawnPiTool, SpawnPiSchema } from "../../src/tools.js";

interface TestTheme {
  bold: (text: string) => string;
  fg: (_color: string, text: string) => string;
}

const theme: TestTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

type RenderDetails =
  | { phase: "working"; progress: BatchProgress }
  | { phase: "finished"; result: SpawnBatchResult }
  | SpawnBatchResult
  | undefined;

interface Rendered {
  render: (width: number) => string[];
}

interface ToolCandidate {
  execute?: unknown;
  parameters?: unknown;
  promptGuidelines?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
}

interface CapturedTool {
  execute: (
    callId: string,
    params: { tasks: SpawnTask[] },
    signal: AbortSignal,
    onUpdate: undefined,
    context: { cwd: string; modelRegistry: { getAvailable: () => unknown[] } }
  ) => Promise<{
    content: { text: string }[];
    details?: RenderDetails;
  }>;
  parameters: {
    properties: {
      tasks: {
        items: {
          properties: {
            role: { description: string };
            thinking: { description: string };
          };
        };
      };
    };
  };
  promptGuidelines: string[];
  renderCall: (args: { tasks?: SpawnTask[] }, theme: TestTheme) => Rendered;
  renderResult: (
    result: {
      content: { type: string; text?: string }[];
      details: RenderDetails;
    },
    options: { expanded: boolean; isPartial: boolean },
    theme: TestTheme,
    context: { args: { tasks: SpawnTask[] } }
  ) => Rendered;
}

const isCapturedTool = (value: ToolCandidate): value is CapturedTool =>
  "execute" in value &&
  typeof value.execute === "function" &&
  "parameters" in value &&
  typeof value.parameters === "object" &&
  value.parameters !== null &&
  "promptGuidelines" in value &&
  Array.isArray(value.promptGuidelines) &&
  "renderCall" in value &&
  typeof value.renderCall === "function" &&
  "renderResult" in value &&
  typeof value.renderResult === "function";

const unusedRunner: BatchRunner = {
  run() {
    throw new Error("The renderer tests do not run the batch runner");
  },
};

const registeredTool = (runner: BatchRunner = unusedRunner): CapturedTool => {
  let tool: CapturedTool | undefined;
  const captureTool: ExtensionAPI["registerTool"] = (definition) => {
    if (!isCapturedTool(definition)) {
      throw new Error("The registered tool has an unexpected shape");
    }
    tool = definition;
  };
  registerSpawnPiTool(
    // SAFETY: This test double is used only to capture the tool definition, the sole ExtensionAPI member registerSpawnPiTool accesses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ExtensionAPI is intentionally narrowed by this test double.
    { registerTool: captureTool } as ExtensionAPI,
    runner,
    () => "parent",
    {
      config: { defaults: {}, orchestrator: { enabled: false }, roles: {} },
      ok: true,
      path: "/config.json",
    }
  );
  if (!tool) {
    throw new Error("The test double did not capture the tool definition");
  }
  return tool;
};

void test("omits placement from the public task schema", () => {
  assert.equal(
    "placement" in SpawnPiSchema.properties.tasks.items.properties,
    false
  );
});

const child = (overrides: Partial<ChildResult> = {}): ChildResult => ({
  paneClosed: true,
  requestIndex: 0,
  status: "succeeded",
  taskId: taskIdFor(0),
  truncated: false,
  ...overrides,
});

const render = (
  tool: CapturedTool,
  details: RenderDetails,
  args: { tasks: SpawnTask[] },
  expanded = false,
  isPartial = false
): string =>
  tool
    .renderResult(
      { content: [{ text: "raw text", type: "text" }], details },
      { expanded, isPartial },
      theme,
      { args }
    )
    .render(500)
    .join("\n")
    .replaceAll(/ +\n/gu, "\n")
    .trimEnd();

void test("guidance prevents requests for unconfigured roles", () => {
  const tool = registeredTool();
  assert.match(
    tool.parameters.properties.tasks.items.properties.role.description,
    /Exact configured Child Role name/u
  );
  assert.ok(
    tool.promptGuidelines.some((guideline: string) =>
      /otherwise omit role/u.test(guideline)
    )
  );
});

void test("guidance discourages routine thinking overrides", () => {
  const tool = registeredTool();
  assert.match(
    tool.parameters.properties.tasks.items.properties.thinking.description,
    /omit by default/u
  );
  assert.ok(
    tool.promptGuidelines.some((guideline: string) =>
      /Omit task\.thinking by default/u.test(guideline)
    )
  );
});

void test("renders a stable partial card with every requested task in request order", () => {
  const tool = registeredTool();
  const output = render(
    tool,
    {
      phase: "working",
      progress: {
        completed: 1,
        results: [
          child({
            location: { paneId: "pane-2", tabId: "tab-5", workspaceId: "w" },
            paneClosed: false,
            requestIndex: 1,
            status: "blocked",
            taskId: taskIdFor(1),
          }),
        ],
        total: 3,
      },
    },
    {
      tasks: [
        { prompt: "one", role: "explore\n\u001B[31m" },
        { prompt: "two", role: "reviewer" },
        { prompt: "three" },
      ],
    },
    false,
    true
  );

  assert.match(output, /^working · 1 of 3 settled/u);
  assert.match(output, /◌ task-1 \[explore \[31m\] working/u);
  assert.match(output, /! task-2 \[reviewer\] needs input · tab-5\/pane-2/u);
  assert.match(output, /◌ task-3 working/u);
});

void test("renders collapsed and expanded final rows with the approved visibility policy", () => {
  const tool = registeredTool();
  const result = {
    requested: 3,
    results: [
      child({
        selection: {
          model: { id: "model", provider: "openai" },
          modelSource: "role",
          thinkingLevel: "low",
          thinkingSource: "default",
        },
        sessionId: "session-1",
        summary: "finished",
        truncated: true,
      }),
      child({
        error: { code: "blocked", message: "Please choose" },
        location: { paneId: "pane-3", tabId: "tab-2", workspaceId: "w" },
        paneClosed: false,
        requestIndex: 1,
        status: "blocked",
        taskId: taskIdFor(1),
      }),
      child({
        error: {
          code: "model_routing_failed",
          message: "No configured model is available",
        },
        requestIndex: 2,
        status: "failed",
        taskId: taskIdFor(2),
      }),
    ],
  };
  const args = {
    tasks: [
      { prompt: "one", role: "explore" },
      { prompt: "two", role: "reviewer" },
      { prompt: "three" },
    ],
  };
  const collapsed = render(tool, { phase: "finished", result }, args);
  const expanded = render(tool, { phase: "finished", result }, args, true);

  assert.match(collapsed, /^× incomplete · 1 of 3 complete/u);
  assert.match(collapsed, /✓ task-1 \[explore\]/u);
  assert.doesNotMatch(
    collapsed,
    /task-1 \[explore\] complete|session-1|openai\/model|finished|Please choose/u
  );
  assert.match(collapsed, /! task-2 \[reviewer\] needs input · tab-2\/pane-3/u);
  assert.match(collapsed, /× task-3 incomplete · model unavailable/u);
  assert.match(
    expanded,
    /finished\nsummary truncated\nmodel: openai\/model\nthinking: low\nmodel selection: role\nthinking selection: default\nsession: session-1/u
  );
  assert.match(expanded, /Please choose/u);
});

void test("renders a distinct timed-out reason", () => {
  const tool = registeredTool();
  const timedOut = child({
    elapsedMs: 1000,
    error: {
      code: "timed_out",
      message: "Child exceeded the global runtime timeout",
    },
    paneClosed: true,
    status: "timed_out",
  });
  const output = render(
    tool,
    { phase: "finished", result: { requested: 1, results: [timedOut] } },
    { tasks: [{ prompt: "one" }] },
    true
  );

  assert.match(output, /× task-1 incomplete · runtime timed out/u);
  assert.match(output, /Child exceeded the global runtime timeout/u);
});

void test("renders successful batches with aggregate completion and icon-only child rows", () => {
  const tool = registeredTool();
  const result = {
    requested: 2,
    results: [child(), child({ requestIndex: 1, taskId: taskIdFor(1) })],
  };
  const output = render(
    tool,
    { phase: "finished", result },
    {
      tasks: [
        { prompt: "one", role: "explore" },
        { prompt: "two", role: "reviewer" },
      ],
    }
  );

  assert.match(output, /^✓ 2 of 2 tasks complete/u);
  assert.match(output, /✓ task-1 \[explore\]/u);
  assert.match(output, /✓ task-2 \[reviewer\]/u);
  assert.equal(output.match(/complete/gu)?.length, 1);
});

void test("returns attributed child answers for successful and mixed executions", async () => {
  const results = [
    {
      requested: 1,
      results: [
        child({
          role: "explore",
          sessionId: "session-1",
          summary: "Implementation report",
        }),
      ],
    },
    {
      requested: 2,
      results: [
        child({ role: "explore", summary: "Investigation report" }),
        child({
          error: { code: "blocked", message: "Please choose" },
          paneClosed: false,
          requestIndex: 1,
          role: "reviewer",
          sessionId: "session-2",
          status: "blocked",
          taskId: taskIdFor(1),
        }),
      ],
    },
  ];
  const tool = registeredTool({
    async run() {
      const result = results.shift();
      if (!result) {
        throw new Error("The test runner ran out of results");
      }
      return await Promise.resolve(result);
    },
  });
  const context = {
    cwd: "/repo",
    modelRegistry: { getAvailable: () => [] },
  };

  const successful = await tool.execute(
    "call-1",
    { tasks: [{ prompt: "one", role: "explore" }] },
    new AbortController().signal,
    undefined,
    context
  );
  const mixed = await tool.execute(
    "call-2",
    {
      tasks: [
        { prompt: "one", role: "explore" },
        { prompt: "two", role: "reviewer" },
      ],
    },
    new AbortController().signal,
    undefined,
    context
  );

  assert.equal(
    successful.content[0].text,
    "spawn_pi: ✓ 1 of 1 task complete\n✓ task-1 [explore] · session session-1\n\n# task-1 result\nImplementation report"
  );
  assert.deepEqual(successful.details, {
    phase: "finished",
    result: {
      requested: 1,
      results: [
        child({
          role: "explore",
          sessionId: "session-1",
          summary: "Implementation report",
        }),
      ],
    },
  });
  assert.equal(
    mixed.content[0].text,
    "spawn_pi: ! needs input · 1 of 2 complete\n✓ task-1 [explore]\n! task-2 [reviewer]: needs input · session session-2 · Please choose\n\n# task-1 result\nInvestigation report"
  );
});

void test("returns multiple child answers in request order", async () => {
  const tool = registeredTool({
    async run() {
      return await Promise.resolve({
        requested: 2,
        results: [
          child({
            requestIndex: 1,
            sessionId: "session-2",
            summary: "Second answer",
            taskId: taskIdFor(1),
          }),
          child({ sessionId: "session-1", summary: "First answer" }),
        ],
      });
    },
  });

  const result = await tool.execute(
    "call",
    { tasks: [{ prompt: "one" }, { prompt: "two" }] },
    new AbortController().signal,
    undefined,
    { cwd: "/repo", modelRegistry: { getAvailable: () => [] } }
  );
  const [{ text }] = result.content;

  assert.ok(text.indexOf("# task-1 result") < text.indexOf("# task-2 result"));
  assert.match(text, /# task-1 result\nFirst answer/u);
  assert.match(text, /# task-2 result\nSecond answer/u);
});

void test("bounds model-visible child answers and identifies every truncation", async () => {
  const tool = registeredTool({
    async run() {
      return await Promise.resolve({
        requested: 8,
        results: Array.from({ length: 8 }, (_, requestIndex) =>
          child({
            requestIndex,
            sessionId:
              requestIndex === 0 ? undefined : `session-${requestIndex + 1}`,
            sessionPath: requestIndex === 0 ? "/tmp/task-1.jsonl" : undefined,
            summary: String(requestIndex + 1).repeat(5000),
            taskId: taskIdFor(requestIndex),
            truncated: requestIndex === 0,
          })
        ),
      });
    },
  });

  const result = await tool.execute(
    "call",
    {
      tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: `${index}` })),
    },
    new AbortController().signal,
    undefined,
    { cwd: "/repo", modelRegistry: { getAvailable: () => [] } }
  );
  const [{ text }] = result.content;

  for (let task = 1; task <= 8; task += 1) {
    const match = new RegExp(
      `# task-${task} result\\n(?<summary>${task}+)\\n\\[task-${task} result truncated`,
      "u"
    ).exec(text);
    assert.equal(match?.groups?.summary.length, 4000);
  }
  assert.match(
    text,
    /\[task-1 result truncated during child result collection and for model-visible output; inspect session path \/tmp\/task-1\.jsonl for the full response\.\]/u
  );
  assert.match(
    text,
    /\[task-8 result truncated for model-visible output; inspect session session-8 for the full response\.\]/u
  );
});

void test("applies the per-child model-visible answer limit", async () => {
  const tool = registeredTool({
    async run() {
      return await Promise.resolve({
        requested: 1,
        results: [child({ sessionId: "session-1", summary: "a".repeat(9000) })],
      });
    },
  });

  const result = await tool.execute(
    "call",
    { tasks: [{ prompt: "one" }] },
    new AbortController().signal,
    undefined,
    { cwd: "/repo", modelRegistry: { getAvailable: () => [] } }
  );
  const [{ text }] = result.content;
  const match =
    /# task-1 result\n(?<summary>a+)\n\[task-1 result truncated/u.exec(text);

  assert.equal(match?.groups?.summary.length, 8000);
});

void test("supports legacy final details and safely falls back to raw content", () => {
  const tool = registeredTool();
  const legacy = {
    requested: 1,
    results: [
      child({
        error: { code: "start_failed", message: "broken" },
        status: "failed",
      }),
    ],
  };

  assert.match(
    render(tool, legacy, { tasks: [{ prompt: "one" }] }),
    /^× incomplete · 0 of 1 complete/u
  );
  assert.equal(
    render(tool, undefined, { tasks: [{ prompt: "one" }] }),
    "raw text"
  );
  assert.equal(
    render(tool, legacy, { tasks: [{ prompt: "one" }] }, false, true),
    "raw text"
  );
  assert.equal(
    tool.renderCall({}, theme).render(500).join("\n").trimEnd(),
    "spawn_pi"
  );
  assert.equal(
    tool
      .renderCall({ tasks: [{ prompt: "one" }] }, theme)
      .render(500)
      .join("\n")
      .trimEnd(),
    "spawn_pi 1 task"
  );
});
