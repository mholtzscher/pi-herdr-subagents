# pi-herdr-subagents

An expert-pilot [Pi](https://pi.dev) package that adds `spawn_pi`: one call starts 1–8 fresh, visible Pi sessions in the current Herdr workspace and collects attributed final answers from their session JSONL files.

## Install

```bash
pi install /path/to/pi-herdr-subagents
```

The package loads safely outside Herdr. Calling `spawn_pi` there returns an actionable unavailable result instead of crashing Pi.

## Use

Ask Parent Pi to call `spawn_pi` with independent tasks. Each task defaults to its own no-focus tab; use `placement: "split"` for a sibling split.

### Child roles and runtime defaults

Optionally copy [`herdr-subagents.example.json`](./herdr-subagents.example.json) to `~/.pi/agent/herdr-subagents.json` and customize it:

```json
{
  "defaults": { "model": ["openai/gpt-5.6-terra", "openai/gpt-5.6-sol"], "thinking": "medium" },
  "roles": {
    "explore": {
      "description": "Fast, read-oriented repository exploration",
      "prompt": "Map relevant code and report evidence. Do not edit unless explicitly asked.",
      "model": ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"],
      "thinking": "low"
    }
  }
}
```

Tasks can set `role`, `model`, and `thinking`. Model and thinking resolve independently: task override, role, configured default, then Parent setting. Config `defaults.model` and `roles.<name>.model` accept either one exact `provider/model-id` string or a non-empty ordered array of them (model IDs may contain `/`). The selected config layer is tried in order against available models; if none is available, the task fails rather than falling through to a lower-precedence layer. Task overrides remain a single string, and inherited Parent models are not availability-validated. A role supplies only an appended identity prompt; it does not replace Pi's system prompt, tools, or project context. The configured role descriptions are visible to Parent Pi, but role prompts and model mappings are not. Config is loaded when the extension loads, so `/reload` picks up edits. Invalid configuration blocks a batch before Herdr is inspected.

Role prompts are passed as local process arguments. Do not put secrets in them. The extension prefixes them as literal Child role instructions so Pi does not interpret prompts that happen to match paths in the Child working directory as files.

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
npm install
```

With direnv installed, allow the included `.envrc` to activate the environment automatically:

```bash
direnv allow
```

Run the same checks as CI:

```bash
devenv test
```

Without devenv, use a local Node.js 22 installation:

```bash
npm install
npm run check
npm test
```
