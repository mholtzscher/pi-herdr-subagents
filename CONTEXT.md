# Parallel Pi Context Offloading

This project lets one Pi instance offload bounded work into fresh Pi context windows hosted visibly by Herdr.

## Product Goal

A **Parent Pi** submits a batch of independent tasks. The extension starts one fresh **Child Pi** per task, runs them concurrently, returns concise attributed results, and closes children whose results were collected successfully.

The product is intentionally not a persistent subagent orchestration system. Fresh context is the feature.

## Language

**Parent Pi**  
The Pi session that invokes the batch spawn tool and receives results. It may enable session-wide Orchestrator Mode to receive proactive delegation guidance.

**Child Pi**  
A fresh Pi session started in a plugin-created Herdr tab or split for exactly one task.

**Batch**  
One tool invocation containing one or more independent child tasks.

**Child Task**  
One bounded prompt assigned to one fresh Child Pi. It may request a configured Child Role plus model and thinking overrides. Child placement is a global configuration preference, not part of the task.

**Child Role** A filename-named set of appended identity guidance and optional runtime metadata loaded from a Role Document. It does not replace Pi's normal system or project context.

**Role Document** One Markdown file in the Role Catalogue. Its filename stem is the case-sensitive Child Role name, optional YAML frontmatter holds `description`, `model`, and `thinking`, and its trimmed body is the role prompt.

**Role Catalogue** The fixed `herdr-subagents/roles/` directory beside the global `herdr-subagents.json` config. It is loaded as direct regular or symlinked `.md` files only.

**Child Result**  
The concise final answer attributed to a Child Task, with status and resumable Pi session identity.

**Attributed Result**  
A final assistant response proven to descend from the marked Child Task prompt in the child Pi session.

**Collected Child**  
A Child Pi whose attributed result and session identity were read successfully. Its plugin-created pane may be closed.

**Inspectable Child**  
A failed, blocked, interrupted, or unattributable Child Pi left visible for human inspection.

## Invariants

- Every Child Task gets a fresh Pi session and fresh context window.
- A Child Pi receives exactly one orchestrated task.
- Tasks in a Batch are independent and run concurrently.
- Children use the Parent Pi's current checkout and normal Pi coding tools. A configured Child Role appends identity guidance without replacing Pi's normal system or project context.
- Concurrent children may edit the same checkout; the extension does not prevent or reconcile conflicts.
- A successful result comes from the marked child Pi session, not terminal scraping.
- A Collected Child is closed only after its result and session ID are safely read.
- An Inspectable Child remains open while its Parent Pi session is active.
- When the Parent Pi exits or replaces its session, the extension closes still-open child panes it created after verifying their occupants; `/reload` leaves them open.
- Closing a child pane does not delete its persisted Pi session; the session can be resumed later by ID.
- Child Pis cannot invoke the batch spawn tool or enable Parent Orchestrator Mode.
- Orchestrator Mode changes Parent guidance only; it does not add persistent child runtimes or orchestration state.
- Fresh Parent sessions use the configured orchestrator default, resumed sessions restore their own session-wide state, and forks inherit the source Parent's current state.
