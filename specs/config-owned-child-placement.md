# Config-Owned Child Placement — Implementation Spec

**Status:** Ready for task breakdown
**Effort:** M (1–3 hours)
**Approved by:** User
**Date:** 2026-08-14

## Decision

Placement is a global user-interface preference. Add optional `defaults.placement` to `~/.pi/agent/herdr-subagents.json`, accepting only `"tab"` or `"split"`. Remove placement from the agent-facing `spawn_pi` task schema and domain request. For every child, the batch runner uses the configured value or `"tab"` when it is absent.

```json
{
  "orchestrator": { "enabled": false },
  "defaults": {
    "placement": "tab",
    "model": ["openai-codex/gpt-5.6-luna"],
    "thinking": "medium"
  }
}
```

The extension continues to load configuration once at startup. Changes require `/reload` and apply to future batches. The setting does not belong in Pi's core `settings.json`.

## Deliverables

| Deliverable | Effort | Depends On |
|---|---:|---|
| D1. Add and validate `defaults.placement` | S | — |
| D2. Remove placement from the agent contract | S | D1 |
| D3. Resolve placement from config in the batch runner | S | D1, D2 |
| D4. Update active documentation and examples | S | D1–D3 |
| D5. Run full verification | S | D1–D4 |

## Implementation Contract

### Configuration and types

`ChildPlacement` remains in `src/domain.ts` for the internal host boundary. `SpawnTask` no longer owns placement.

```diff
diff --git a/src/domain.ts b/src/domain.ts
@@
 export interface SpawnTask {
   prompt: string;
-  placement?: ChildPlacement;
   role?: string;
   model?: string;
   thinking?: ChildThinkingLevel;
 }
```

Global child defaults own placement, while role runtime defaults remain limited to model and thinking. This prevents Role Document frontmatter from acquiring placement structurally.

```diff
diff --git a/src/model-routing.ts b/src/model-routing.ts
@@
 import type {
+  ChildPlacement,
   ChildRuntimeSelection,
@@
 export interface ChildRuntimeDefaults {
   model?: ConfiguredModel;
   thinking?: ChildThinkingLevel;
 }
+
+export interface ChildDefaults extends ChildRuntimeDefaults {
+  placement?: ChildPlacement;
+}
+
 export interface ChildRole extends ChildRuntimeDefaults {
@@
 export interface ChildRolesConfig {
-  defaults: ChildRuntimeDefaults;
+  defaults: ChildDefaults;
   roles: Record<string, ChildRole>;
 }
```

Extend `parseDefaults` in `src/model-routing.ts`:

```diff
diff --git a/src/model-routing.ts b/src/model-routing.ts
@@
-  rejectUnsupported(defaults, ["model", "thinking"], name);
+  rejectUnsupported(defaults, ["placement", "model", "thinking"], name);
   const result: ChildDefaults = {};
+  if (defaults.placement !== undefined)
+    result.placement = validatePlacement(defaults.placement, `${name}.placement`);
```

`validatePlacement` returns `ChildPlacement` or throws a configuration error stating that the value must be `tab` or `split`. Existing config-error handling must reject any other type or value before Herdr inspection. Absence remains valid and resolves to `"tab"` only at execution.

### Agent and execution interfaces

Remove placement from the public TypeBox schema and from `validateSpawnBatchRequest`. This is an intentional breaking change to the tool-call contract: request-level placement is no longer advertised, typed, validated, or read, and cannot override configuration.

```diff
diff --git a/src/tools.ts b/src/tools.ts
@@
 const SpawnTaskSchema = Type.Object({
   prompt: Type.String({ minLength: 1, description: "One independent, bounded task for a fresh Pi" }),
-  placement: Type.Optional(
-    StringEnum(["tab", "split"] as const, { description: "Visible child placement; defaults to tab" }),
-  ),
   role: Type.Optional(Type.String({ minLength: 1, description: "Configured Child Role name" })),
```

Resolve placement for each child from the already-loaded routing config:

```diff
diff --git a/src/batch.ts b/src/batch.ts
@@
       child = await this.host.start(
         {
           taskId,
-          placement: task.placement ?? "tab",
+          placement: routing.config.defaults.placement ?? "tab",
```

`ChildHost.start(request: StartChildRequest)` remains unchanged and receives a required, resolved `ChildPlacement`. `src/herdr/host.ts` remains configuration-agnostic and continues to map `"tab"` to `tab.create` and `"split"` to `pane.split`; concurrency and Herdr protocols do not change.

### Affected files

```text
src/
├── domain.ts                    # modify — remove placement from SpawnTask and request validation
├── tools.ts                     # modify — remove placement from the public tool schema
├── model-routing.ts             # modify — own global placement type, parsing, and validation
└── batch.ts                     # modify — resolve configured placement for each child

test/
├── unit/domain.test.ts          # modify — remove request-placement cases
├── unit/tools.test.ts           # modify — assert the public task schema omits placement
├── unit/model-routing.test.ts   # modify — cover placement config parsing
└── integration/batch.test.ts    # modify — verify resolved placement reaches ChildHost

herdr-subagents.example.json     # modify — show defaults.placement
README.md                        # modify — document ownership, path, default, and reload behavior
CONTEXT.md                       # modify — remove placement from the Child Task definition
```

No production files or packages are added.

## Scope Boundaries

- Placement is global; there are no task, role, project, rule-based, or agent overrides.
- Split direction and layout strategy remain Herdr behavior rather than new configuration.
- Existing model and thinking routing precedence and behavior remain unchanged.

## Acceptance and Verification

| Acceptance criterion | Verification |
|---|---|
| `spawn_pi` and `SpawnTask` omit task-level placement, and request validation contains no placement behavior. | Inspect the registered `SpawnPiSchema` and domain types; retain existing task count, prompt, role, model, and thinking tests. |
| `defaults.placement` accepts `"tab"`, `"split"`, or omission. | Load temporary JSON for all three cases in `test/unit/model-routing.test.ts`. |
| Other values, including `"pane"`, `true`, and `null`, produce the existing invalid-config result before Herdr inspection. | Add config unit cases for each value. |
| Configured `"split"` sends every child in a batch through the unchanged `pane.split` host path; configured `"tab"` uses `tab.create`. | Assert every emitted `StartChildRequest` has the configured placement in batch integration tests; retain host mapping coverage. |
| Missing config or missing `defaults.placement` sends every child as `"tab"`. | Cover implicit tab behavior in config unit and batch integration tests. |
| Child roles cannot specify or override placement. | Keep `ChildRole` based on `ChildRuntimeDefaults`, leave role parser keys unchanged, and cover the type/parser boundary. |
| Model and thinking routing behavior is unchanged. | Run the existing routing and full regression suites. |
| Active examples and documentation identify `~/.pi/agent/herdr-subagents.json`, the tab fallback, global ownership, and `/reload`. | Review `herdr-subagents.example.json`, `README.md`, and `CONTEXT.md`. |
| Repository validation passes. | Run `pnpm test` and `pnpm check`. |

## Consequences

- Existing saved prompts or callers that send placement must adopt the new tool contract; there is no agent-supplied compatibility fallback. Default-tab users need no configuration migration.
- Users who choose global `"split"` accept the current Herdr behavior in which a multi-child batch may reshape the parent tab; no layout algorithm is added.
- Resolving placement in `src/batch.ts` keeps configuration out of the host while preserving its required internal placement contract.

## Success Criterion

After setting placement once in `~/.pi/agent/herdr-subagents.json` and running `/reload`, every future child uses that placement, while the agent has no placement control in its tool schema.
