import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { BatchRunner } from "./batch.js";
import type { BatchProgress, ChildResult, SpawnBatchResult, SpawnTask } from "./domain.js";
import { taskIdFor } from "./domain.js";
import { roleGuidance, type ChildRolesConfigLoadResult } from "./model-routing.js";

const SpawnTaskSchema = Type.Object({
  prompt: Type.String({ minLength: 1, description: "One independent, bounded task for a fresh Pi" }),
  placement: Type.Optional(
    StringEnum(["tab", "split"] as const, { description: "Visible child placement; defaults to tab" }),
  ),
  role: Type.Optional(Type.String({ minLength: 1, description: "Configured Child Role name" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Exact provider/model override" })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
});

export const SpawnPiSchema = Type.Object({
  tasks: Type.Array(SpawnTaskSchema, { minItems: 1, maxItems: 8, description: "One to eight independent tasks" }),
});

export type SpawnPiToolInput = Static<typeof SpawnPiSchema>;

type SpawnPiDisplayDetails =
  | { phase: "working"; progress: BatchProgress }
  | { phase: "finished"; result: SpawnBatchResult };

type ChildDisplayState = "working" | "complete" | "needs_input" | "incomplete";
type BatchDisplayState = "working" | "complete" | "needs_input" | "incomplete";

export function registerSpawnPiTool(
  pi: ExtensionAPI,
  runner: BatchRunner,
  getParentLabel: () => string,
  configResult: ChildRolesConfigLoadResult,
): void {
  pi.registerTool<typeof SpawnPiSchema, SpawnPiDisplayDetails>({
    name: "spawn_pi",
    label: "Spawn Pi",
    description:
      "Run 1–8 independent bounded tasks concurrently in fresh visible Pi sessions hosted by Herdr. Children share the current checkout and cannot invoke spawn_pi.",
    promptSnippet: "Offload independent repository exploration or bounded work to fresh visible Pi sessions",
    promptGuidelines: [
      "Use spawn_pi only for 1–8 independent tasks; children share the checkout and may interfere with concurrent edits.",
      ...(configResult.ok && roleGuidance(configResult.config) ? [roleGuidance(configResult.config)!] : []),
    ],
    parameters: SpawnPiSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!configResult.ok)
        throw new Error(`Invalid Child Roles config at ${configResult.path}: ${configResult.error}`);
      const result = await runner.run(
        { tasks: params.tasks },
        {
          cwd: ctx.cwd,
          parentLabel: getParentLabel(),
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
          thinkingLevel: ctx.thinkingLevel,
        },
        {
          config: configResult.config,
          availableModels: ctx.modelRegistry
            .getAvailable()
            .map((model) => ({ provider: model.provider, id: model.id })),
        },
        {
          signal,
          onProgress(progress) {
            onUpdate?.({
              content: [{ type: "text", text: summarizeProgress(progress) }],
              details: { phase: "working", progress } satisfies SpawnPiDisplayDetails,
            });
          },
        },
      );
      return {
        content: [{ type: "text", text: summarize(result) }],
        details: { phase: "finished", result } satisfies SpawnPiDisplayDetails,
      };
    },
    renderCall(args, theme) {
      const tasks = requestedTasks(args);
      const count = tasks?.length;
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_pi")) +
          (count === undefined ? "" : theme.fg("accent", ` ${count} task${count === 1 ? "" : "s"}`)),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = displayDetails(result.details, isPartial);
      if (!details) return new Text(rawText(result.content), 0, 0);

      const tasks = requestedTasks(context.args);
      const progress = details.phase === "working" ? details.progress : undefined;
      const batch = details.phase === "finished" ? details.result : undefined;
      const total = progress?.total ?? batch?.requested ?? tasks?.length ?? 0;
      const settled = new Map<number, ChildResult>();
      for (const result of progress?.results ?? batch?.results ?? []) {
        settled.set(result.requestIndex, result);
      }
      const state = batchDisplayState(details);
      const header =
        details.phase === "working"
          ? `working · ${details.progress.completed} of ${details.progress.total} settled`
          : `${stateIcon(state)} ${finalBatchStatus(details.result, state)}`;
      const lines = [theme.fg(stateColor(state), header)];
      for (let requestIndex = 0; requestIndex < total; requestIndex += 1) {
        const task = tasks?.[requestIndex];
        lines.push(renderChild(taskIdFor(requestIndex), task?.role, settled.get(requestIndex), expanded, theme));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

function childDisplayState(result: ChildResult | undefined): ChildDisplayState {
  if (!result) return "working";
  if (result.status === "succeeded") return "complete";
  if (result.status === "blocked") return "needs_input";
  return "incomplete";
}

function batchDisplayState(details: SpawnPiDisplayDetails): BatchDisplayState {
  if (details.phase === "working") return "working";
  const { requested, results } = details.result;
  if (results.length !== requested) return "incomplete";
  const states = results.map(childDisplayState);
  if (states.every((state) => state === "complete")) return "complete";
  if (states.every((state) => state === "complete" || state === "needs_input")) return "needs_input";
  return "incomplete";
}

function shortReason(result: ChildResult): string | undefined {
  if (result.status === "unattributable") return "result unreadable";
  if (result.status === "parent_aborted") return "parent stopped waiting";
  if (result.status !== "failed") return undefined;
  switch (result.error?.code) {
    case "role_not_found":
      return "role not found";
    case "model_routing_failed":
      return "model unavailable";
    case "start_failed":
      return "could not start";
    case "prompt_failed":
      return "prompt failed";
    case "result_unreadable":
      return "result unreadable";
    case "parent_aborted":
      return "parent stopped waiting";
    default:
      return "unknown failure";
  }
}

function summarizeProgress(progress: BatchProgress): string {
  return `spawn_pi: working · ${progress.completed} of ${progress.total} settled`;
}

function summarize(result: SpawnBatchResult): string {
  const details: SpawnPiDisplayDetails = { phase: "finished", result };
  const batchState = batchDisplayState(details);
  const lines = [`spawn_pi: ${stateIcon(batchState)} ${finalBatchStatus(result, batchState)}`];
  for (const child of orderedResults(result.results)) {
    const state = childDisplayState(child);
    const role = presentationRole(child.role);
    let line = `${stateIcon(state)} ${child.taskId}${role ? ` [${role}]` : ""}`;
    if (state !== "complete") line += `: ${displayLabel(state)}`;
    const reason = shortReason(child);
    if (reason) line += ` · ${reason}`;
    if (child.sessionId) line += ` · session ${child.sessionId}`;
    if (child.error && state !== "complete") line += ` · ${child.error.message}`;
    lines.push(line);
  }
  return lines.join("\n");
}

function renderChild(
  taskId: string,
  requestedRole: string | undefined,
  result: ChildResult | undefined,
  expanded: boolean,
  theme: Theme,
): string {
  const state = childDisplayState(result);
  const role = presentationRole(requestedRole);
  let line = `${theme.fg(stateColor(state), stateIcon(state))} ${theme.fg("toolTitle", taskId)}${role ? theme.fg("muted", ` [${role}]`) : ""}`;
  if (state !== "complete") line += ` ${theme.fg(stateColor(state), displayLabel(state))}`;
  const reason = result && shortReason(result);
  if (state === "incomplete" && reason) line += theme.fg("muted", ` · ${reason}`);
  const location = result && !result.paneClosed ? locationText(result) : undefined;
  if (state === "needs_input" && location) line += theme.fg("muted", ` · ${location}`);
  if (!expanded || !result) return line;

  const details: string[] = [];
  if (state === "complete" && result.summary) details.push(theme.fg("toolOutput", result.summary));
  if (state === "complete" && result.truncated) details.push(theme.fg("muted", "summary truncated"));
  if (state === "needs_input" || state === "incomplete") {
    if (result.error?.message) details.push(theme.fg("error", result.error.message));
  }
  if (location && !(state === "needs_input" && location)) details.push(theme.fg("muted", `location: ${location}`));
  if (result.selection?.model)
    details.push(theme.fg("muted", `model: ${result.selection.model.provider}/${result.selection.model.id}`));
  if (result.selection?.thinkingLevel) details.push(theme.fg("muted", `thinking: ${result.selection.thinkingLevel}`));
  if (result.selection?.modelSource)
    details.push(theme.fg("muted", `model selection: ${result.selection.modelSource}`));
  if (result.selection?.thinkingSource)
    details.push(theme.fg("muted", `thinking selection: ${result.selection.thinkingSource}`));
  if (result.sessionId) details.push(theme.fg("muted", `session: ${result.sessionId}`));
  return details.length ? `${line}\n${details.join("\n")}` : line;
}

function displayDetails(
  value: SpawnPiDisplayDetails | SpawnBatchResult | undefined,
  isPartial: boolean,
): SpawnPiDisplayDetails | undefined {
  if (value === undefined) return undefined;
  if ("phase" in value) return value;
  return isPartial ? undefined : { phase: "finished", result: value };
}

function requestedTasks(value: { tasks?: SpawnTask[] }): SpawnTask[] | undefined {
  return value.tasks;
}

function rawText(content: readonly { type: string; text?: string }[]): string {
  const text = content.find((part) => part.type === "text");
  return text?.text ?? "spawn_pi finished";
}

function successfulCount(result: SpawnBatchResult | undefined): number {
  return result?.results.filter((child) => child.status === "succeeded").length ?? 0;
}

function finalBatchStatus(result: SpawnBatchResult, state: BatchDisplayState): string {
  const completed = successfulCount(result);
  if (state === "complete")
    return `${completed} of ${result.requested} ${result.requested === 1 ? "task" : "tasks"} complete`;
  return `${displayLabel(state)} · ${completed} of ${result.requested} complete`;
}

function orderedResults(results: ChildResult[]): ChildResult[] {
  return [...results].sort((left, right) => left.requestIndex - right.requestIndex);
}

function presentationRole(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  const value = Array.from(role, (character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return value || undefined;
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function locationText(result: ChildResult): string | undefined {
  return result.location ? `${result.location.tabId}/${result.location.paneId}` : undefined;
}

function displayLabel(state: ChildDisplayState | BatchDisplayState): string {
  return state === "needs_input" ? "needs input" : state;
}

function stateIcon(state: ChildDisplayState | BatchDisplayState): string {
  return state === "working" ? "◌" : state === "complete" ? "✓" : state === "needs_input" ? "!" : "×";
}

function stateColor(state: ChildDisplayState | BatchDisplayState): ThemeColor {
  return state === "working"
    ? "accent"
    : state === "complete"
      ? "success"
      : state === "needs_input"
        ? "warning"
        : "error";
}
