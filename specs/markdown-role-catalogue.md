# Markdown Role Catalogue — Implementation Spec

**Status:** Ready for task breakdown **Effort:** M (2–4 focused hours) **Approved by:** User **Date:** 2026-08-14

## Problem and Decision

Long Child Role prompts are escaped JSON strings in `~/.pi/agent/herdr-subagents.json`, which makes them difficult to read, edit, and review. Move each role into one Markdown **role document**: the filename stem is the role name, the body is the appended identity prompt, and optional YAML frontmatter contains role metadata.

Keep `herdr-subagents.json` as the **global config** for `orchestrator` and `defaults`. Load the **role catalogue** from a fixed directory derived by removing the config filename extension and appending `/roles`:

```text
~/.pi/agent/
├── herdr-subagents.json
└── herdr-subagents/
    └── roles/
        ├── explore.md
        └── reviewer.md
```

This is a breaking migration. A JSON `roles` property fails with an actionable message directing the user to `herdr-subagents/roles/<name>.md`. The loader normalizes role documents into the existing `Record<string, ChildRole>`, so routing, batching, concurrency, rendering, child lifecycle, and prompt transport retain their current semantics.

## Configuration Contract

Global config remains strict JSON:

```json
{
  "orchestrator": { "enabled": false },
  "defaults": {
    "model": ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"],
    "thinking": "medium"
  }
}
```

`~/.pi/agent/herdr-subagents/roles/explore.md`:

```md
---
description: Read-only codebase reconnaissance and evidence gathering.
model:
  - openai-codex/gpt-5.6-luna
  - openai-codex/gpt-5.6-sol
thinking: low
---

Act as a read-only repository investigator.

Locate the relevant entry points, trace important control flow, and cite file paths and line ranges. Do not modify files.
```

### Discovery and naming

- Load direct regular files and symlinks whose names end exactly in `.md`. Ignore subdirectories and other entries; do not recurse. Symlink targets must be readable role documents; dangling or invalid links fail the complete configuration.
- Derive the case-sensitive application role name by removing the final `.md`. It must satisfy the existing non-whitespace role-name rule. Filesystem case-collision rules still apply.
- Sort entries by filename before parsing for deterministic validation and errors.
- A missing role catalogue is empty. A missing global config supplies the existing empty global defaults but does not prevent an existing catalogue from loading.

### Document format and validation

- Frontmatter is optional. When the first line is `---`, a closing `---` line is required; otherwise the whole document is the prompt.
- Parse frontmatter as YAML 1.2 with the `yaml` package and no custom tags. It must be empty or an object with only `description`, `model`, and `thinking`; syntax errors and duplicate keys are invalid.
- Trim the prompt at both ends and require non-whitespace content. Preserve internal Markdown whitespace and line breaks.
- Preserve existing metadata validation: `description` is non-whitespace; `model` is one exact `provider/model-id` or a non-empty ordered array; `thinking` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- An unreadable catalogue or document, or any invalid role document, invalidates the complete configuration. `ChildRolesConfigLoadResult.path` identifies the exact failing global config, catalogue, or role document.
- Invalid configuration retains current fail-closed behavior: orchestrator mode is unavailable and a batch is blocked before Herdr inspection or child startup.

Configuration loads once with the extension; `/reload` reloads both sources. Role prompts must not contain secrets. Existing private temporary-file transport keeps prompt contents out of process arguments, and existing redaction keeps prompts and unselected role model candidates out of Parent guidance, rendering, results, and routing errors. Results and expanded rendering continue to show the selected model, thinking level, and selection sources.

## Scope

The implementation covers one fixed role catalogue, migration of shipped examples and documentation, and strict parsing at the existing configuration boundary. It does not add nested discovery, arbitrary paths, project-local catalogues, includes, inheritance, templating, or file watching. Task overrides and model/thinking precedence are unchanged.

## Implementation Contract

### Types

`src/model-routing.ts` continues to own normalized configuration. Existing exported types remain unchanged:

```ts
export interface ChildRole extends ChildRuntimeDefaults {
  description?: string;
  prompt: string;
}

export interface ChildRolesConfig {
  defaults: ChildRuntimeDefaults;
  roles: Record<string, ChildRole>;
}

export type ChildRolesConfigLoadResult =
  | { ok: true; path: string; config: HerdrSubagentsConfig }
  | { ok: false; path: string; error: string };
```

Add only an internal frontmatter type. Treat the YAML parser result as untrusted, verify that it is empty or an object, then pass its fields through the existing `ConfigInput` validators:

```ts
interface RoleFrontmatter {
  description?: string;
  model?: ConfiguredModel;
  thinking?: ChildThinkingLevel;
}
```

No task, result, persistence, event, or API type changes are required. `ChildRole`, `ChildRolesConfig`, `ModelRoutingContext`, and `ChildRuntimeSelection` remain the downstream boundary.

### Loader interface

The exported signature remains source-compatible:

```ts
export function loadChildRolesConfig(
  path = join(getAgentDir(), "herdr-subagents.json")
): ChildRolesConfigLoadResult;
```

For `/path/name.json`, derive `/path/name/roles`. Load the optional global config and catalogue independently, then return one normalized `HerdrSubagentsConfig`. On failure, return the existing failure union instead of throwing during extension registration.

Private helpers may remain in `src/model-routing.ts`:

```ts
function rolesDirectoryFor(configPath: string): string;
function loadRolesDirectory(path: string): Record<string, ChildRole>;
function parseRoleDocument(
  contents: string,
  path: string
): RoleFrontmatter & { prompt: string };
function parseRoleFrontmatter(value: unknown, name: string): RoleFrontmatter;
```

They own deterministic path derivation, synchronous discovery, filename naming, document separation, YAML parsing, source-aware errors, and reuse of `parseObject()`, `rejectUnsupported()`, `parseNonWhitespace()`, `validateModel()`, and `validateThinking()`. Returned role records must preserve the existing own-property lookup defense. `resolveChildRuntime()` and `roleGuidance()` do not change.

### Project layout and deliverables

```text
package.json                              # modify — declare `yaml` as a runtime dependency
pnpm-lock.yaml                           # modify — update the direct dependency relationship
herdr-subagents.example.json             # modify — retain global settings only
herdr-subagents.example/
└── roles/
    ├── explore.md                       # new — example role document
    └── reviewer.md                      # new — example role document
src/
└── model-routing.ts                     # modify — load and validate the role catalogue
README.md                                # modify — document setup, format, migration, and reload
CONTEXT.md                               # modify — define role document and catalogue terminology
test/unit/model-routing.test.ts          # modify — cover loading, validation, migration, and examples
specs/child-roles.md                     # modify — mark its JSON role contract as superseded
specs/markdown-role-catalogue.md          # new — this contract
```

| ID | Deliverable | Effort | Depends on |
| --- | --- | --: | --- |
| D1 | Add the `yaml` dependency and catalogue loader with strict validation | M | — |
| D2 | Move shipped role examples into Markdown and update user documentation | S | D1 |
| D3 | Update domain/spec references and run full verification | S | D1, D2 |

Keep loading in `src/model-routing.ts`, which owns the current configuration boundary. Extracting private parsing into `src/role-catalogue.ts` is permitted only if implementation readability requires it; exported interfaces and ownership remain unchanged.

## Migration

Move each former JSON role to `<config-basename>/roles/<name>.md`, place `description`, `model`, and `thinking` in frontmatter, and place `prompt` in the body. Remove the JSON `roles` property, preserve `orchestrator` and `defaults`, then run `/reload`.

Before:

```json
{
  "roles": {
    "explore": {
      "description": "Read-only exploration",
      "prompt": "Investigate the repository.\n\nDo not edit files.",
      "thinking": "low"
    }
  }
}
```

After `~/.pi/agent/herdr-subagents/roles/explore.md`:

```md
---
description: Read-only exploration
thinking: low
---

Investigate the repository.

Do not edit files.
```

No automated migration command is included.

## Acceptance and Verification

- [ ] A role document produces a filename-derived `ChildRole` whose trimmed body becomes `ChildRole.prompt` and, when selected, the internal `rolePrompt`; body-only documents are valid.
- [ ] Frontmatter metadata normalizes and routes exactly like the former JSON role fields, including scalar and ordered-array models.
- [ ] Missing global config and catalogue sources normalize independently, including loading roles without a JSON file.
- [ ] Discovery accepts direct regular files and symlinks, remains non-recursive and sorted, and is restricted to exact `.md` suffixes.
- [ ] Empty prompts; malformed, unterminated, duplicate-key, non-object, or unsupported frontmatter; invalid metadata or role names; and unreadable sources fail the complete load and identify the responsible source path.
- [ ] A JSON `roles` property reports the Markdown migration path, with no inline-role fallback.
- [ ] Guidance exposes only names and descriptions. Prompt contents and unselected role model candidates remain redacted; selected model/thinking values and their sources remain visible in results and expanded rendering.
- [ ] Existing task overrides, model/thinking precedence and availability selection, Parent fallback, batch concurrency, lifecycle, and private temporary prompt transport remain unchanged.
- [ ] Shipped global config and role examples load successfully through the production loader.
- [ ] Long shipped prompts are ordinary multiline Markdown, and editing one role requires changing only its role document unless global defaults change.
- [ ] `pnpm check` and `pnpm test` pass.

Use temporary directory trees in `test/unit/model-routing.test.ts` to cover path derivation, discovery filtering and order, regular files and symlinks, missing sources, body-only and frontmatter documents, prompt whitespace, YAML and metadata failures, migration errors, and source paths. Retain the pure routing/redaction tests against normalized in-memory roles and existing integration coverage for batch and host behavior. Add production-loader coverage for shipped examples.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Existing inline role configurations break | Emit an actionable migration error and document the one-file-per-role conversion while preserving metadata semantics |
| YAML permits surprising or expensive constructs | Use YAML 1.2 without custom tags, honor parser duplicate/alias protections, and apply strict type and unknown-field validation |
| One invalid document disables all roles and orchestrator mode | Preserve fail-closed behavior and report the exact failing source |
| Discovery expands beyond intended local files | Use the fixed, non-recursive directory and direct `.md` files or symlinks only; provide no includes |
| Migration changes prompt formatting | Trim only document edges, preserve internal content, and test multiline paragraphs and lists |
| Direct runtime dependency is omitted because it is already transitive | Declare `yaml` in `dependencies` and verify the lockfile and clean checks |

## Resolved Decisions

The user selected directory-only roles, filename-derived names, and YAML frontmatter. The catalogue location, discovery, breaking migration, strict fail-closed errors, and unchanged downstream semantics are fixed by this spec. There are no open questions.

---

_Spec approved for task decomposition._
