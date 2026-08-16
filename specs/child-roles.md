# Child Roles — Implementation Spec

**Status:** Superseded by [`markdown-role-catalogue.md`](./markdown-role-catalogue.md)<br /> **Effort:** L (approximately 4–8 focused hours, 75% confidence)<br /> **Approved by:** User<br /> **Date:** 2026-08-12

## Supersession

The JSON `roles` configuration contract in this specification is superseded by the Markdown Role Catalogue contract. Global `orchestrator` and `defaults` remain in `herdr-subagents.json`; each role now resides in `herdr-subagents/roles/<name>.md`. The implementation must reject inline JSON roles and direct users to the Markdown migration described in [`markdown-role-catalogue.md`](./markdown-role-catalogue.md).

## Problem and Decision

Every Child Pi currently inherits one Parent model and thinking level through `src/tools.ts`, `src/batch.ts`, and `src/herdr/host.ts`. This can make routine delegated work unnecessarily expensive and forces callers to repeat role instructions.

Add optional `role`, `model`, and `thinking` fields to each Child Task. Load prompt-free runtime defaults and named Child Roles from `~/.pi/agent/herdr-subagents.json`, resolved with Pi's exported `getAgentDir()`.

Resolve model and thinking independently:

```text
Model:    task.model    > role.model    > config.defaults.model    > Parent model
Thinking: task.thinking > role.thinking > config.defaults.thinking > Parent thinking
Identity: configured role.prompt only; no role means no role identity prompt
```

A role prompt appends to Pi's normal system prompt; it does not replace Pi's coding instructions, tools, or project context. Exact task fields remain escape hatches. Calls without new fields retain current behavior when no package defaults are configured.

A missing config file means empty defaults and no roles. Invalid JSON or config shape blocks the entire batch before inspection, Parent rename, or child startup. With valid config, an unknown role or unavailable routed model fails only that task before pane creation; independent tasks continue concurrently and results remain in request order.

### Scope boundaries

This release does not infer roles, select models from cost metadata, provide built-in vendor/model defaults, or add project-local configuration. Configured default and role model fields may provide ordered availability fallbacks; task overrides and inherited Parent models remain single selections. Roles do not define custom per-task prompts, tools, permissions, skills, placement, task templates, or reusable Child runtimes. Pi retains responsibility for thinking-level capability clamping.

## Superseded JSON Configuration Contract

```json
{
  "defaults": {
    "model": ["openai/gpt-5.6-terra", "openai/gpt-5.6-sol"],
    "thinking": "medium"
  },
  "roles": {
    "explore": {
      "description": "Fast, read-oriented repository exploration",
      "prompt": "You are a repository explorer. Map relevant code and report evidence. Do not edit files unless explicitly asked.",
      "model": ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"],
      "thinking": "low"
    },
    "implement": {
      "description": "Focused implementation and verification",
      "prompt": "You are an implementation specialist. Make surgical changes and verify them.",
      "thinking": "high"
    }
  }
}
```

- `defaults` and `roles` are optional and normalize to empty objects. Defaults may contain only `model` and `thinking`; they never define identity.
- Role names are case-sensitive, non-empty strings. Every role requires a non-whitespace `prompt`; optional `description` must be non-whitespace.
- `defaults.model` and `roles.<name>.model` accept either one exact canonical `provider/model-id` string or a non-empty ordered array of exact canonical strings. Tasks accept only one exact canonical string. Reject empty arrays, non-string entries, whitespace-padded entries, and malformed references. Split on the first `/` because the model ID may contain `/`.
- Thinking is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Wrong types, invalid or empty required values, and unsupported properties invalidate the complete config.
- Config loads once with the extension. `/reload` reloads it; edits do not affect an already loaded instance.
- `description` is Parent-facing guidance. Full role prompts and model mappings never enter tool guidance, rendering, results, or Parent model context.
- Role prompts must not contain secrets because process arguments may be visible to other local processes. Transport prefixes the prompt with a literal instruction heading so Pi cannot interpret a prompt matching a path in the Child working directory as a file.

## Types and Ownership

### `src/domain.ts`

```ts
export type ChildThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SelectionSource = "explicit" | "role" | "default" | "parent";

export interface ModelReference {
  provider: string;
  id: string;
}

export interface SpawnTask {
  prompt: string;
  placement?: ChildPlacement;
  role?: string;
  model?: string;
  thinking?: ChildThinkingLevel;
}

export interface ChildRuntimeSelection {
  model?: ModelReference;
  modelSource?: SelectionSource;
  thinkingLevel?: ChildThinkingLevel;
  thinkingSource?: SelectionSource;
  rolePrompt?: string;
}

export interface ChildResult {
  // existing fields unchanged
  taskId: TaskId;
  requestIndex: number;
  role?: string;
  selection?: Omit<ChildRuntimeSelection, "rolePrompt">;
  error?: {
    code:
      | "role_not_found"
      | "model_routing_failed"
      | "start_failed"
      | "prompt_failed"
      | "result_unreadable"
      | "blocked"
      | "parent_aborted";
    message: string;
  };
}

export interface ParentContext {
  cwd: string;
  parentLabel?: string;
  model?: ModelReference;
  thinkingLevel?: ChildThinkingLevel;
}
```

`rolePrompt` is runtime-only. `selection` records the model and thinking level requested from Pi plus each source; it does not claim to report Pi's effective, possibly clamped thinking level. A source is present only when its corresponding value is present.

The TypeBox schema and `validateSpawnBatchRequest()` apply the task validation above and reject whitespace-only `role` and `model` values.

### `src/model-routing.ts`

```ts
export type ConfiguredModel = string | string[];

export interface ChildRuntimeDefaults {
  model?: ConfiguredModel;
  thinking?: ChildThinkingLevel;
}

export interface ChildRole extends ChildRuntimeDefaults {
  description?: string;
  prompt: string;
}

export interface ChildRolesConfig {
  defaults: ChildRuntimeDefaults;
  roles: Record<string, ChildRole>;
}

export type ChildRolesConfigLoadResult =
  | { ok: true; path: string; config: ChildRolesConfig }
  | { ok: false; path: string; error: string };

export interface ModelRoutingContext {
  config: ChildRolesConfig;
  availableModels: readonly ModelReference[];
}

export type ChildRuntimeResolution =
  | { ok: true; selection: ChildRuntimeSelection }
  | {
      ok: false;
      code: "role_not_found" | "model_routing_failed";
      message: string;
      selection?: Omit<ChildRuntimeSelection, "rolePrompt">;
    };

export function loadChildRolesConfig(
  path?: string // default: join(getAgentDir(), "herdr-subagents.json")
): ChildRolesConfigLoadResult;

export function resolveChildRuntime(input: {
  task: SpawnTask;
  parent: ParentContext;
  routing: ModelRoutingContext;
}): ChildRuntimeResolution;

export function roleGuidance(config: ChildRolesConfig): string | undefined;
```

The loader performs synchronous extension-load I/O. Missing files produce a successful empty config; parse or validation errors return the path without crashing package loading.

The resolver is pure. It validates a requested role before resolving model and thinking independently. Unknown roles return `role_not_found` even when task model/thinking overrides are present, because identity cannot be fulfilled. It chooses a model layer by precedence first. A selected task, role, or default layer is checked against `availableModels`; scalar layers have one candidate and configured arrays select their first available candidate by exact provider/id match. If no candidate in that selected layer is available, return `model_routing_failed` without falling through to a lower-precedence layer. Inherited Parent models bypass availability validation. If no layer selects a model, omit it and let Pi use normal startup selection.

`roleGuidance()` returns only role names and optional descriptions. This in-process module needs no adapter or class hierarchy.

## Integration Contracts

### Tool adapter — `src/tools.ts`

Extend `SpawnTaskSchema`:

```ts
role: Type.Optional(Type.String({ minLength: 1, description: "Configured Child Role name" })),
model: Type.Optional(Type.String({ minLength: 1, description: "Exact provider/model override" })),
thinking: Type.Optional(
  StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
),
```

`registerSpawnPiTool()` receives `ChildRolesConfigLoadResult` at extension load. Valid role names/descriptions augment tool guidance. On execution, invalid config throws an actionable error containing its path before invoking `BatchRunner`. Otherwise the adapter maps `ctx.modelRegistry.getAvailable()` to canonical `ModelReference` values and passes the config and catalogue as `ModelRoutingContext`; routing is intentionally independent of `ctx.scopedModels`.

Rendering shows the requested role and selected model/thinking compactly and may show sources when expanded. It never renders role prompts.

### Batch runner — `src/batch.ts`

```ts
export interface BatchRunner {
  run(
    request: SpawnBatchRequest,
    context: ParentContext,
    routing: ModelRoutingContext,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: BatchProgress) => void;
    }
  ): Promise<SpawnBatchResult>;
}
```

For each task, `ConcurrentBatchRunner` resolves runtime selection before `host.start()`. Failure completes that task with the routing error and never starts its pane. Success creates a child-specific `ParentContext`, replacing model and thinking with resolved values, and passes `rolePrompt` separately. Routing does not change existing attribution, blocked/abort behavior, verified close, or Parent-session cleanup after startup.

### Child host — `src/herdr/host.ts`

```ts
export interface StartChildRequest {
  taskId: TaskId;
  placement: ChildPlacement;
  sessionId: string;
  context: ParentContext;
  rolePrompt?: string;
  parent: HostInspection;
}
```

`piArgs()` adds canonical `--model`, `--thinking`, and one `--append-system-prompt` argument when selected. The role prompt is prefixed with a literal instruction heading, written to a private temporary file, and passed by path so multiline or shell-sensitive content never enters Herdr's shell argument encoding. The temporary file is removed after startup succeeds or fails.

## Delivery and Verification

| ID | Deliverable | Depends on | Verification |
| --- | --- | --- | --- |
| D1 | Add domain types plus strict config loader, guidance, and pure resolver in `src/model-routing.ts`. | — | Unit tests for scalar and ordered config models, validation, precedence, first available candidate selection, slash-containing IDs, unavailable selected layers, and guidance/routing redaction. |
| D2 | Wire config/catalogue through `src/index.ts`, `src/tools.ts`, and `src/batch.ts`; add per-task failures, result metadata, rendering, and host prompt transport. | D1 | Adapter tests prove invalid config prevents runner/inspection/rename; batch tests mix valid tasks, unknown roles, and unavailable routes; host tests assert model, thinking, and one non-shell prompt argument. |
| D3 | Update `README.md` and `CONTEXT.md`; preserve current lifecycle coverage. | D1, D2 | Tests cover missing config, compatibility without defaults, scoped-model independence, prompt redaction, `/reload` semantics, and unchanged attribution/abort/cleanup behavior. Run `pnpm check` and `pnpm test`. |

Acceptance requires:

- task → role → default → Parent precedence is applied independently to model and thinking, including mixed-source selections;
- known roles append identity while preserving Pi's normal system and project context;
- invalid config causes no batch side effects, while per-task routing errors do not stop independent tasks;
- selected config layers choose their first available candidate; all-unavailable selected layers fail without lower-layer fallback, while inherited Parent models remain unvalidated;
- authenticated models outside Parent scoped models are routable;
- results and guidance expose the approved metadata without role prompts or model mappings;
- existing tasks remain behaviorally compatible without new fields or defaults; and
- all repository checks pass.

## Residual Risks

- Role prompts are visible in local process arguments; documentation must prohibit secrets.
- Config and guidance remain stale until `/reload` by design.
- Results report requested thinking while Pi may clamp the effective level.
- Model availability can change after catalogue validation; later startup failure uses existing failure semantics.

## Resolved Decisions

- Inherited Parent models bypass `getAvailable()` validation to preserve compatibility; catalogue validation applies to task, role, and default routes.
- Configured role names must be non-whitespace strings.
