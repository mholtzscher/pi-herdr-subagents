import { randomUUID } from "node:crypto";
import {
  childPrompt,
  type BatchProgress,
  type ChildResult,
  type ParentContext,
  type SpawnBatchRequest,
  type SpawnBatchResult,
  taskIdFor,
  validateSpawnBatchRequest,
} from "./domain.js";
import { emptyChildRolesConfig, resolveChildRuntime, type ModelRoutingContext } from "./model-routing.js";
import { StartChildError, type ChildHost } from "./herdr/host.js";
import type { ChildResultReader } from "./results.js";

export interface BatchRunner {
  run(
    request: SpawnBatchRequest,
    context: ParentContext,
    routing: ModelRoutingContext,
    options?: { signal?: AbortSignal; onProgress?: (progress: BatchProgress) => void },
  ): Promise<SpawnBatchResult>;
}

export class ConcurrentBatchRunner implements BatchRunner {
  constructor(private readonly host: ChildHost, private readonly reader: ChildResultReader) {}

  async run(
    request: SpawnBatchRequest,
    context: ParentContext,
    routing: ModelRoutingContext = { config: emptyChildRolesConfig(), availableModels: [] },
    options: { signal?: AbortSignal; onProgress?: (progress: BatchProgress) => void } = {},
  ): Promise<SpawnBatchResult> {
    validateSpawnBatchRequest(request);
    let parent;
    try {
      parent = await this.host.inspect(options.signal);
      await this.host.renameParent(parent, context, options.signal);
    } catch (error) {
      return options.signal?.aborted ? this.abortBeforeStart(request) : this.inspectFailure(request, messageOf(error));
    }

    let completed = 0;
    const results = await Promise.all(
      request.tasks.map((task, requestIndex) =>
        this.runTask(task, requestIndex, context, routing, parent, options.signal, () => {
          completed += 1;
          options.onProgress?.({ completed, total: request.tasks.length, results: [] });
        }),
      ),
    );
    return { requested: request.tasks.length, results };
  }

  private async runTask(
    task: SpawnBatchRequest["tasks"][number],
    requestIndex: number,
    context: ParentContext,
    routing: ModelRoutingContext,
    parent: Awaited<ReturnType<ChildHost["inspect"]>>,
    signal: AbortSignal | undefined,
    onComplete: () => void,
  ): Promise<ChildResult> {
    const taskId = taskIdFor(requestIndex);
    const resolution = resolveChildRuntime({ task, parent: context, routing });
    const base = {
      taskId,
      requestIndex,
      truncated: false,
      paneClosed: false,
      ...(task.role === undefined ? {} : { role: task.role }),
      ...(resolution.ok ? { selection: visibleSelection(resolution.selection) } : resolution.selection ? { selection: resolution.selection } : {}),
    };
    if (!resolution.ok) {
      const result: ChildResult = { ...base, status: "failed", error: { code: resolution.code, message: resolution.message } };
      onComplete();
      return result;
    }
    const childContext: ParentContext = {
      ...context,
      model: resolution.selection.model ?? context.model,
      thinkingLevel: resolution.selection.thinkingLevel ?? context.thinkingLevel,
    };
    let child;
    try {
      child = await this.host.start({
        taskId,
        placement: task.placement ?? "tab",
        sessionId: randomUUID(),
        context: childContext,
        rolePrompt: resolution.selection.rolePrompt,
        parent,
      }, signal);
    } catch (error) {
      const childFields = fieldsForStartError(error);
      const result: ChildResult = {
        ...base,
        ...childFields,
        status: signal?.aborted ? "parent_aborted" : "failed",
        error: signal?.aborted
          ? { code: "parent_aborted", message: "Parent stopped waiting before child startup completed" }
          : { code: "start_failed", message: messageOf(error) },
      };
      onComplete();
      return result;
    }
    const childFields = { sessionId: child.sessionId, sessionPath: child.sessionPath, location: child.location };
    const settlement = await raceAbort(this.host.prompt(child, childPrompt(taskId, task)), signal).catch((error) => ({ error }));
    if (!settlement) {
      const result: ChildResult = {
        ...base,
        ...childFields,
        status: "parent_aborted",
        error: { code: "parent_aborted", message: "Parent stopped waiting; child remains open" },
      };
      onComplete();
      return result;
    }
    if ("error" in settlement) {
      const result: ChildResult = { ...base, ...childFields, status: "failed", error: { code: "prompt_failed", message: messageOf(settlement.error) } };
      onComplete();
      return result;
    }
    if (settlement.status === "blocked") {
      const result: ChildResult = { ...base, ...childFields, status: "blocked", error: { code: "blocked", message: "Child requires input and remains open" } };
      onComplete();
      return result;
    }
    if (!child.sessionPath) {
      const result: ChildResult = { ...base, ...childFields, status: "unattributable", error: { code: "result_unreadable", message: "Child session path was not reported" } };
      onComplete();
      return result;
    }
    try {
      const answer = await this.reader.read({ sessionPath: child.sessionPath, taskId, baselineEntryId: child.baselineEntryId, maxChars: 20_000 });
      let paneClosed = false;
      try {
        await this.host.close(child);
        paneClosed = true;
      } catch {
        // The answer is already attributed; a changed or unavailable occupant must remain visible.
      }
      const result: ChildResult = { ...base, ...childFields, status: "succeeded", summary: answer.summary, truncated: answer.truncated, paneClosed };
      onComplete();
      return result;
    } catch (error) {
      const result: ChildResult = { ...base, ...childFields, status: "unattributable", error: { code: "result_unreadable", message: messageOf(error) } };
      onComplete();
      return result;
    }
  }

  private inspectFailure(request: SpawnBatchRequest, message: string): SpawnBatchResult {
    return {
      requested: request.tasks.length,
      results: request.tasks.map((_, requestIndex) => ({
        taskId: taskIdFor(requestIndex),
        requestIndex,
        status: "failed",
        truncated: false,
        paneClosed: false,
        error: { code: "start_failed", message },
      })),
    };
  }

  private abortBeforeStart(request: SpawnBatchRequest): SpawnBatchResult {
    return {
      requested: request.tasks.length,
      results: request.tasks.map((_, requestIndex) => ({
        taskId: taskIdFor(requestIndex),
        requestIndex,
        status: "parent_aborted",
        truncated: false,
        paneClosed: false,
        error: { code: "parent_aborted", message: "Parent stopped waiting before batch startup" },
      })),
    };
  }
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function visibleSelection(selection: import("./domain.js").ChildRuntimeSelection): Omit<import("./domain.js").ChildRuntimeSelection, "rolePrompt"> {
  const { rolePrompt: _, ...visible } = selection;
  return visible;
}

function fieldsForStartError(error: unknown): Pick<ChildResult, "sessionId" | "sessionPath" | "location"> {
  if (!(error instanceof StartChildError) || !error.child) return {};
  return {
    sessionId: error.child.sessionId,
    sessionPath: error.child.sessionPath,
    location: error.child.location,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
