---
status: accepted
---

# Herdr hosts short-lived Child Pi processes

Child Pis are normal interactive Pi processes in Herdr-managed tabs or splits. Herdr owns terminal topology, process startup, recognized-agent prompting, and pane closure. The extension owns only the current batch's task IDs, result attribution, and the record of resources created by that tool call.

This rejects hidden subprocesses because children must remain visible and inspectable while working. It also rejects a persistent runtime registry: fresh context windows, not reusable agents, are the product.

The extension may close a child only after collecting its attributed result and resumable Pi session ID, and only after verifying that the target resource was created by the current tool call and still contains the expected child. Failed, blocked, aborted, or unattributable children remain visible.
