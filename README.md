# pi-herdr-subagents

An expert-pilot [Pi](https://pi.dev) package that adds `spawn_pi`: one call starts 1–8 fresh, visible Pi sessions in the current Herdr workspace and collects attributed final answers from their session JSONL files.

## Install

```bash
pi install /path/to/pi-herdr-subagents
```

The package loads safely outside Herdr and keeps `spawn_pi` inactive there.

## Use

Enable orchestrator mode, then ask Parent Pi to call `spawn_pi` with independent tasks. The call is synchronous: Parent Pi remains blocked while the children run and until all results are collected. Children use the global placement configured in `~/.pi/agent/herdr-subagents.json`, defaulting to separate no-focus tabs when it is omitted. The live result card shows every task in request order as `working`, `complete`, `needs input`, or `incomplete`; requested roles appear as visible row badges, while runtime details appear only when expanded.

Every successful child's final answer is also returned in request order through the tool-result content visible to Parent Pi. Model-visible summary payloads are limited to 8,000 characters per child and 32,000 characters per batch. When the aggregate limit applies, it is divided evenly among successful summaries and remains subject to the per-child limit. A truncation marker identifies the task and its session ID or path so Parent Pi can deliberately inspect the full response. Structured child results remain in tool-result details for the expanded renderer and persisted-session consumers.

### Orchestrator mode

Use `/orchestrator` to toggle a Parent mode that delegates only when fresh context, independent parallel work, or specialized review provides a clear benefit. Because one child provides no parallel speedup, single-child delegation is reserved for a concrete fresh-context or specialized-expertise benefit; batches are reserved for genuinely independent concurrent work. Every Child Task must identify its objective, scope, exclusions, deliverable, verification, and stop condition. The Parent uses the smallest useful batch, avoids duplicating completed investigation, assigns disjoint ownership for concurrent implementation, and retains responsibility for synthesis and final verification. Explicit forms are `/orchestrator on`, `/orchestrator off`, and `/orchestrator status`. A footer indicator is shown while the mode is enabled. Turning orchestrator mode off also disables the `spawn_pi` tool; turning it on restores the tool.

Use `/orchestrator cost` for a current-session snapshot showing the Parent, each discovered Child Pi, the children subtotal, and the grand total. It reads usage already persisted in the Parent and child session files, so an in-flight response appears only after Pi persists it. The displayed values use Pi's recorded model-cost metadata and are estimates rather than invoices.

Orchestrator state is session-wide and survives resume, reload, and tree navigation. Fresh sessions use `orchestrator.enabled` from `~/.pi/agent/herdr-subagents.json`; forks inherit the source session's current state. Missing configuration defaults to disabled. Child Pis and Pi sessions outside Herdr cannot enable the mode.

### Child roles and runtime defaults

Copy the shipped global config and role catalogue, then customize them:

```bash
cp herdr-subagents.example.json ~/.pi/agent/herdr-subagents.json
cp -R herdr-subagents.example ~/.pi/agent/herdr-subagents
```

The global config contains only Orchestrator and Child defaults:

```json
{
  "orchestrator": { "enabled": false },
  "defaults": {
    "placement": "tab",
    "timeoutSeconds": 600,
    "model": ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"],
    "thinking": "medium"
  }
}
```

`defaults.placement` is a global user-interface preference accepting `"tab"` or `"split"`. It applies to every child, cannot be set by a task or role, and falls back to `"tab"` when omitted.

`defaults.timeoutSeconds` is the global runtime limit for each child after startup. It accepts a positive integer up to `2147483`, defaults to `600` seconds when omitted, and can be set to `false` to disable the limit. Timed-out children have only their outstanding prompt wait aborted; their attributed session ID and path are retained, and their pane is closed after occupant verification when possible.

Each role is a Markdown document in `~/.pi/agent/herdr-subagents/roles/`; direct `.md` symlinks, such as those created by Home Manager, are supported. Its filename stem is the case-sensitive role name. Put optional `description`, `model`, and `thinking` metadata in YAML frontmatter; the trimmed document body is the appended identity prompt:

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

Tasks can set `role`, `model`, and `thinking`. Model and thinking resolve independently: task override, role, configured default, then Parent setting. Config `defaults.model` and role frontmatter `model` accept either one exact `provider/model-id` string or a non-empty ordered array of them (model IDs may contain `/`). The selected config layer is tried in order against available models; if none is available, the task fails rather than falling through to a lower-precedence layer. Task overrides remain a single string, and inherited Parent models are not availability-validated. A role supplies only an appended identity prompt; it does not replace Pi's system prompt, tools, or project context. The configured role descriptions are visible to Parent Pi, but role prompts and model mappings are not.

This replaces the former JSON `roles` property. Move each old `roles.<name>` entry to `herdr-subagents/roles/<name>.md`, put `description`, `model`, and `thinking` in frontmatter, put `prompt` in the body, and remove `roles` from the JSON file. Inline JSON roles are rejected; there is no automated migration command.

Configuration is loaded when the extension loads. Run `/reload` after editing either the JSON config or a role document; placement changes apply to future batches, while role and runtime changes apply to future fresh sessions. Reloading does not reset the current session's Orchestrator state. Invalid configuration disables Orchestrator mode with a warning and blocks a batch before Herdr is inspected.

Role prompts must not contain secrets. The extension writes the literal Child role instruction heading and prompt to a private temporary file, then passes that file to Pi; prompt contents are not placed in process arguments.

At session start, the extension generates and stores a short internal Parent label (for example, `amber-finch`). The Parent tab is renamed `Pi [<parent>]`; each child tab, pane, and Pi session is named `Pi [<parent>] task-N` (for example, `Pi [amber-finch] task-1`). The label is unrelated to the Parent Pi's `/name` and does not affect the `/resume` list. This keeps children from concurrent Parent Pis distinguishable. Successful results include a child session ID. Closing the child pane does **not** delete that session; resume it with:

```bash
pi --session <id>
# or use /resume in Pi
```

## Important pilot limitation

All children work in the Parent Pi's current checkout concurrently. They can overwrite or invalidate each other's edits, observe changing files, and interfere through tests or Git operations. This package does no locking, write detection, reconciliation, rollback, persistence, or background collection. Review the final checkout yourself.

Blocked, failed, interrupted, and unattributable children are deliberately left visible in Herdr for inspection while the Parent session remains active. Parent abort stops collection only; it does not interrupt or close accepted children. When the Parent Pi exits or switches to a new, resumed, or forked session, the extension closes still-open child panes it created after verifying their occupants. `/reload` does not close children.

## Development

With [devenv](https://devenv.sh/) installed, enter the Node.js 22 development shell:

```bash
devenv shell
pnpm install
```

With direnv installed, allow the included `.envrc` to activate the environment automatically:

```bash
direnv allow
```

Run the same checks as CI:

```bash
devenv test
```

Without devenv, use local Node.js 22 and pnpm installations:

```bash
pnpm install
pnpm check
pnpm test
```
