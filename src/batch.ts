import { randomUUID } from "node:crypto";

import { childPrompt, taskIdFor, validateSpawnBatchRequest } from "./domain.js";
import type {
  BatchProgress,
  ChildResult,
  ChildRuntimeSelection,
  ParentContext,
  SpawnBatchRequest,
  SpawnBatchResult,
} from "./domain.js";
import { StartChildError } from "./herdr/host.js";
import type { ChildHost, ChildSettlement, HostedChild } from "./herdr/host.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  emptyChildRolesConfig,
  resolveChildRuntime,
} from "./model-routing.js";
import type { ModelRoutingContext } from "./model-routing.js";
import type { ChildResultReader } from "./results.js";

const DEFAULT_ROUTING: ModelRoutingContext = {
  availableModels: [],
  config: emptyChildRolesConfig(),
};
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const VERIFIED_CLOSE_TIMEOUT_MS = 5000;

const runtimeTimeout = (routing: ModelRoutingContext): number | false =>
  routing.config.defaults.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

const visibleSelection = (
  selection: ChildRuntimeSelection
): Omit<ChildRuntimeSelection, "rolePrompt"> => {
  const { rolePrompt: _, ...visible } = selection;
  return visible;
};

const fieldsForStartError = (
  cause: unknown
): Pick<ChildResult, "sessionId" | "sessionPath" | "location"> => {
  if (!(cause instanceof StartChildError) || !cause.child) {
    return {};
  }
  return {
    location: cause.child.location,
    sessionId: cause.child.sessionId,
    sessionPath: cause.child.sessionPath,
  };
};

type PromptOutcome =
  | { kind: "settled"; settlement: ChildSettlement }
  | { kind: "error"; error: unknown }
  | { kind: "parent_aborted" }
  | { kind: "timed_out"; elapsedMs: number };

const settledPrompt = async (
  prompt: () => Promise<ChildSettlement>
): Promise<PromptOutcome> => {
  try {
    return { kind: "settled", settlement: await prompt() };
  } catch (error) {
    return { error, kind: "error" };
  }
};

const waitForPrompt = async (
  prompt: () => Promise<ChildSettlement>,
  timeoutSeconds: number | false,
  timeoutController: AbortController,
  startedAt: number,
  signal?: AbortSignal
): Promise<PromptOutcome> =>
  // oxlint-disable-next-line promise/avoid-new, promise/no-multiple-resolved -- A guarded resolver coordinates three competing outcomes.
  await new Promise<PromptOutcome>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = new AbortController();
    const finish = (outcome: PromptOutcome) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      cleanup.abort();
      // oxlint-disable-next-line promise/no-multiple-resolved -- The finished guard permits only the winning outcome.
      resolve(outcome);
    };

    if (signal?.aborted === true) {
      finish({ kind: "parent_aborted" });
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        finish({ kind: "parent_aborted" });
      },
      { once: true, signal: cleanup.signal }
    );
    if (timeoutSeconds !== false) {
      const delayMs = Math.max(
        0,
        timeoutSeconds * 1000 - (Date.now() - startedAt)
      );
      timer = setTimeout(() => {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        timeoutController.abort();
        finish({ elapsedMs, kind: "timed_out" });
      }, delayMs);
    }
    void settledPrompt(prompt).then(finish);
  });

const closeExpectedChild = async (
  host: ChildHost,
  child: HostedChild
): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, VERIFIED_CLOSE_TIMEOUT_MS);
  try {
    await host.close(child, controller.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const terminalPromptResult = async (
  outcome: PromptOutcome,
  base: Omit<ChildResult, "status" | "error">,
  childFields: Pick<ChildResult, "location" | "sessionId" | "sessionPath">,
  host: ChildHost,
  child: HostedChild
): Promise<
  | { result: ChildResult }
  | { outcome: Extract<PromptOutcome, { kind: "error" | "settled" }> }
> => {
  if (outcome.kind === "parent_aborted") {
    return {
      result: {
        ...base,
        ...childFields,
        error: {
          code: "parent_aborted",
          message: "Parent stopped waiting; child remains open",
        },
        status: "parent_aborted",
      },
    };
  }
  if (outcome.kind !== "timed_out") {
    return { outcome };
  }
  const paneClosed = await closeExpectedChild(host, child);
  return {
    result: {
      ...base,
      ...childFields,
      elapsedMs: outcome.elapsedMs,
      error: {
        code: "timed_out",
        message: "Child exceeded the global runtime timeout",
      },
      paneClosed,
      status: "timed_out",
    },
  };
};

export interface BatchRunner {
  run: (
    request: SpawnBatchRequest,
    context: ParentContext,
    routing: ModelRoutingContext,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: BatchProgress) => void;
    }
  ) => Promise<SpawnBatchResult>;
}

export class ConcurrentBatchRunner implements BatchRunner {
  private readonly host: ChildHost;
  private readonly reader: ChildResultReader;

  constructor(host: ChildHost, reader: ChildResultReader) {
    this.host = host;
    this.reader = reader;
  }

  async run(
    request: SpawnBatchRequest,
    context: ParentContext,
    routing: ModelRoutingContext = DEFAULT_ROUTING,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: BatchProgress) => void;
    } = {}
  ): Promise<SpawnBatchResult> {
    validateSpawnBatchRequest(request);
    const total = request.tasks.length;
    options.onProgress?.({ completed: 0, results: [], total });
    let parent;
    try {
      parent = await this.host.inspect(options.signal);
      await this.host.renameParent(parent, context, options.signal);
    } catch (error) {
      const result =
        options.signal?.aborted === true
          ? ConcurrentBatchRunner.abortBeforeStart(request)
          : ConcurrentBatchRunner.inspectFailure(request, messageOf(error));
      options.onProgress?.({
        completed: total,
        results: [...result.results],
        total,
      });
      return result;
    }

    const settled: (ChildResult | undefined)[] = Array.from({ length: total });
    const snapshot = () => {
      const results = settled.filter(
        (result): result is ChildResult => result !== undefined
      );
      options.onProgress?.({ completed: results.length, results, total });
    };
    const results = await Promise.all(
      request.tasks.map(async (task, requestIndex) => {
        const result = await this.runTask(
          task,
          requestIndex,
          context,
          routing,
          parent,
          options.signal
        );
        settled[requestIndex] = result;
        snapshot();
        return result;
      })
    );
    return { requested: total, results };
  }

  private async runTask(
    task: SpawnBatchRequest["tasks"][number],
    requestIndex: number,
    context: ParentContext,
    routing: ModelRoutingContext,
    parent: Awaited<ReturnType<ChildHost["inspect"]>>,
    signal: AbortSignal | undefined
  ): Promise<ChildResult> {
    const taskId = taskIdFor(requestIndex);
    const resolution = resolveChildRuntime({ parent: context, routing, task });
    const base: Omit<ChildResult, "status" | "error"> = {
      paneClosed: false,
      requestIndex,
      taskId,
      truncated: false,
    };
    if (task.role !== undefined) {
      base.role = task.role;
    }
    if (resolution.ok) {
      base.selection = visibleSelection(resolution.selection);
    } else if (resolution.selection) {
      base.selection = resolution.selection;
    }
    if (!resolution.ok) {
      const result: ChildResult = {
        ...base,
        error: { code: resolution.code, message: resolution.message },
        status: "failed",
      };
      return result;
    }
    const childContext: ParentContext = {
      ...context,
      model: resolution.selection.model ?? context.model,
      thinkingLevel:
        resolution.selection.thinkingLevel ?? context.thinkingLevel,
    };
    let child;
    let startedAt = 0;
    try {
      child = await this.host.start(
        {
          context: childContext,
          parent,
          placement: routing.config.defaults.placement ?? "tab",
          rolePrompt: resolution.selection.rolePrompt,
          sessionId: randomUUID(),
          taskId,
        },
        signal
      );
      startedAt = Date.now();
    } catch (error) {
      const childFields = fieldsForStartError(error);
      const result: ChildResult = {
        ...base,
        ...childFields,
        error:
          signal?.aborted === true
            ? {
                code: "parent_aborted",
                message:
                  "Parent stopped waiting before child startup completed",
              }
            : { code: "start_failed", message: messageOf(error) },
        status: signal?.aborted === true ? "parent_aborted" : "failed",
      };
      return result;
    }
    const childFields = {
      location: child.location,
      sessionId: child.sessionId,
      sessionPath: child.sessionPath,
    };
    const timeoutController = new AbortController();
    const promptOutcome = await waitForPrompt(
      async () =>
        await this.host.prompt(
          child,
          childPrompt(taskId, task),
          timeoutController.signal
        ),
      runtimeTimeout(routing),
      timeoutController,
      startedAt,
      signal
    );
    const terminal = await terminalPromptResult(
      promptOutcome,
      base,
      childFields,
      this.host,
      child
    );
    if ("result" in terminal) {
      return terminal.result;
    }
    const activeOutcome = terminal.outcome;
    if (activeOutcome.kind === "error") {
      return {
        ...base,
        ...childFields,
        error: {
          code: "prompt_failed",
          message: messageOf(activeOutcome.error),
        },
        status: "failed",
      };
    }
    const { settlement } = activeOutcome;
    if (settlement.status === "blocked") {
      const result: ChildResult = {
        ...base,
        ...childFields,
        error: {
          code: "blocked",
          message: "Child requires input and remains open",
        },
        status: "blocked",
      };
      return result;
    }
    if (child.sessionPath === undefined || child.sessionPath.length === 0) {
      const result: ChildResult = {
        ...base,
        ...childFields,
        error: {
          code: "result_unreadable",
          message: "Child session path was not reported",
        },
        status: "unattributable",
      };
      return result;
    }
    try {
      const answer = await this.reader.read({
        baselineEntryId: child.baselineEntryId,
        maxChars: 20_000,
        sessionPath: child.sessionPath,
        taskId,
      });
      let paneClosed = false;
      try {
        await this.host.close(child);
        paneClosed = true;
      } catch {
        // The answer is already attributed; a changed or unavailable occupant must remain visible.
      }
      const result: ChildResult = {
        ...base,
        ...childFields,
        paneClosed,
        status: "succeeded",
        summary: answer.summary,
        truncated: answer.truncated,
      };
      return result;
    } catch (error) {
      const result: ChildResult = {
        ...base,
        ...childFields,
        error: { code: "result_unreadable", message: messageOf(error) },
        status: "unattributable",
      };
      return result;
    }
  }

  private static inspectFailure(
    request: SpawnBatchRequest,
    message: string
  ): SpawnBatchResult {
    return {
      requested: request.tasks.length,
      results: request.tasks.map((_, requestIndex) => ({
        error: { code: "start_failed", message },
        paneClosed: false,
        requestIndex,
        status: "failed",
        taskId: taskIdFor(requestIndex),
        truncated: false,
      })),
    };
  }

  private static abortBeforeStart(
    request: SpawnBatchRequest
  ): SpawnBatchResult {
    return {
      requested: request.tasks.length,
      results: request.tasks.map((_, requestIndex) => ({
        error: {
          code: "parent_aborted",
          message: "Parent stopped waiting before batch startup",
        },
        paneClosed: false,
        requestIndex,
        status: "parent_aborted",
        taskId: taskIdFor(requestIndex),
        truncated: false,
      })),
    };
  }
}
