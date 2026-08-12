# Parallel Pi Context Offloading

This project lets one Pi instance offload bounded work into fresh Pi context windows hosted visibly by Herdr.

## Product Goal

A **Parent Pi** submits a batch of independent tasks. The extension starts one fresh **Child Pi** per task, runs them concurrently, returns concise attributed results, and closes children whose results were collected successfully.

The product is intentionally not a persistent subagent orchestration system. Fresh context is the feature.

## Language

**Parent Pi**  
The Pi session that invokes the batch spawn tool and receives results.

**Child Pi**  
A fresh Pi session started in a plugin-created Herdr tab or split for exactly one task.

**Batch**  
One tool invocation containing one or more independent child tasks.

**Child Task**  
One bounded prompt assigned to one fresh Child Pi.

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
- Children use the Parent Pi's current checkout and normal Pi coding tools.
- Concurrent children may edit the same checkout; the extension does not prevent or reconcile conflicts.
- A successful result comes from the marked child Pi session, not terminal scraping.
- A Collected Child is closed only after its result and session ID are safely read.
- An Inspectable Child remains open.
- Closing a child pane does not delete its persisted Pi session; the session can be resumed later by ID.
- Child Pis cannot invoke the batch spawn tool.
