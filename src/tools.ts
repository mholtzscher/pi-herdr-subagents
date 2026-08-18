import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { BatchRunner } from "./batch.js";
import type {
  BatchProgress,
  ChildResult,
  SpawnBatchResult,
  SpawnTask,
} from "./domain.js";
import { taskIdFor } from "./domain.js";
import { roleGuidance } from "./model-routing.js";
import type { ChildRolesConfigLoadResult } from "./model-routing.js";

const SpawnTaskSchema = Type.Object({
  model: Type.Optional(
    Type.String({ description: "Exact provider/model override", minLength: 1 })
  ),
  prompt: Type.String({
    description: "One independent, bounded task for a fresh Pi",
    minLength: 1,
  }),
  role: Type.Optional(
    Type.String({
      description:
        "Exact configured Child Role name; omit when no matching role is listed",
      minLength: 1,
    })
  ),
  thinking: Type.Optional(
    StringEnum(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
      {
        description:
          "Optional exact thinking-level override; omit by default and set only when the user requests it or the task cannot succeed with the configured or inherited level",
      }
    )
  ),
});

export const SpawnPiSchema = Type.Object({
  tasks: Type.Array(SpawnTaskSchema, {
    description: "One to eight independent tasks",
    maxItems: 8,
    minItems: 1,
  }),
});

export type SpawnPiToolInput = Static<typeof SpawnPiSchema>;

type SpawnPiDisplayDetails =
  | { phase: "working"; progress: BatchProgress }
  | { phase: "finished"; result: SpawnBatchResult };

type ChildDisplayState = "working" | "complete" | "needs_input" | "incomplete";
type BatchDisplayState = "working" | "complete" | "needs_input" | "incomplete";

const isControlCharacter = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

const presentationRole = (role: string | undefined): string | undefined => {
  if (role === undefined) {
    return undefined;
  }
  const value = Array.from(role, (character) =>
    isControlCharacter(character) ? " " : character
  )
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return value || undefined;
};

const childDisplayState = (
  result: ChildResult | undefined
): ChildDisplayState => {
  if (!result) {
    return "working";
  }
  if (result.status === "succeeded") {
    return "complete";
  }
  if (result.status === "blocked") {
    return "needs_input";
  }
  return "incomplete";
};

const displayLabel = (state: ChildDisplayState | BatchDisplayState): string => {
  if (state === "needs_input") {
    return "needs input";
  }
  return state;
};

const stateIcon = (state: ChildDisplayState | BatchDisplayState): string => {
  if (state === "working") {
    return "◌";
  }
  if (state === "complete") {
    return "✓";
  }
  if (state === "needs_input") {
    return "!";
  }
  return "×";
};

const stateColor = (
  state: ChildDisplayState | BatchDisplayState
): ThemeColor => {
  if (state === "working") {
    return "accent";
  }
  if (state === "complete") {
    return "success";
  }
  if (state === "needs_input") {
    return "warning";
  }
  return "error";
};

const shortReason = (result: ChildResult): string | undefined => {
  if (result.status === "unattributable") {
    return "result unreadable";
  }
  if (result.status === "parent_aborted") {
    return "parent stopped waiting";
  }
  if (result.status === "timed_out") {
    return "runtime timed out";
  }
  if (result.status !== "failed") {
    return undefined;
  }
  switch (result.error?.code) {
    case "role_not_found": {
      return "role not found";
    }
    case "model_routing_failed": {
      return "model unavailable";
    }
    case "start_failed": {
      return "could not start";
    }
    case "prompt_failed": {
      return "prompt failed";
    }
    case "result_unreadable": {
      return "result unreadable";
    }
    case "parent_aborted": {
      return "parent stopped waiting";
    }
    case "timed_out": {
      return "runtime timed out";
    }
    case "blocked":
    case undefined: {
      return "unknown failure";
    }
    default: {
      return "unknown failure";
    }
  }
};

const locationText = (result: ChildResult): string | undefined => {
  if (!result.location) {
    return undefined;
  }
  return `${result.location.tabId}/${result.location.paneId}`;
};

const successfulCount = (result: SpawnBatchResult | undefined): number =>
  result?.results.filter((child) => child.status === "succeeded").length ?? 0;

const orderedResults = (results: ChildResult[]): ChildResult[] => {
  const ordered: ChildResult[] = [];
  for (const result of results) {
    const insertionIndex = ordered.findIndex(
      (orderedResult) => orderedResult.requestIndex > result.requestIndex
    );
    if (insertionIndex === -1) {
      ordered.push(result);
    } else {
      ordered.splice(insertionIndex, 0, result);
    }
  }
  return ordered;
};

const batchDisplayState = (
  details: SpawnPiDisplayDetails
): BatchDisplayState => {
  if (details.phase === "working") {
    return "working";
  }
  const { requested, results } = details.result;
  if (results.length !== requested) {
    return "incomplete";
  }
  const states = results.map(childDisplayState);
  if (states.every((state) => state === "complete")) {
    return "complete";
  }
  if (
    states.every((state) => state === "complete" || state === "needs_input")
  ) {
    return "needs_input";
  }
  return "incomplete";
};

const finalBatchStatus = (
  result: SpawnBatchResult,
  state: BatchDisplayState
): string => {
  const completed = successfulCount(result);
  if (state === "complete") {
    const taskLabel = result.requested === 1 ? "task" : "tasks";
    return `${completed} of ${result.requested} ${taskLabel} complete`;
  }
  return `${displayLabel(state)} · ${completed} of ${result.requested} complete`;
};

const summarizeProgress = (progress: BatchProgress): string =>
  `spawn_pi: working · ${progress.completed} of ${progress.total} settled`;

const MODEL_VISIBLE_CHILD_SUMMARY_MAX_CHARS = 8000;
const MODEL_VISIBLE_SUMMARIES_MAX_CHARS = 32_000;

const childSessionReference = (child: ChildResult): string => {
  if (child.sessionId !== undefined && child.sessionId.length > 0) {
    return `session ${child.sessionId}`;
  }
  if (child.sessionPath !== undefined && child.sessionPath.length > 0) {
    return `session path ${child.sessionPath}`;
  }
  return "the child session (no session ID/path was recorded)";
};

const appendSuccessfulSummaries = (
  lines: string[],
  results: ChildResult[]
): void => {
  const successful = results.filter(
    (child) =>
      child.status === "succeeded" &&
      child.summary !== undefined &&
      child.summary.length > 0
  );
  if (successful.length === 0) {
    return;
  }
  const maxChars = Math.min(
    MODEL_VISIBLE_CHILD_SUMMARY_MAX_CHARS,
    Math.floor(MODEL_VISIBLE_SUMMARIES_MAX_CHARS / successful.length)
  );
  for (const child of successful) {
    const summary = child.summary ?? "";
    const modelVisibleTruncated = summary.length > maxChars;
    lines.push("", `# ${child.taskId} result`, summary.slice(0, maxChars));
    if (child.truncated || modelVisibleTruncated) {
      const reasons = [
        ...(child.truncated ? ["during child result collection"] : []),
        ...(modelVisibleTruncated ? ["for model-visible output"] : []),
      ];
      lines.push(
        `[${child.taskId} result truncated ${reasons.join(" and ")}; inspect ${childSessionReference(child)} for the full response.]`
      );
    }
  }
};

const summarize = (result: SpawnBatchResult): string => {
  const details: SpawnPiDisplayDetails = { phase: "finished", result };
  const batchState = batchDisplayState(details);
  const lines = [
    `spawn_pi: ${stateIcon(batchState)} ${finalBatchStatus(result, batchState)}`,
  ];
  for (const child of orderedResults(result.results)) {
    const state = childDisplayState(child);
    const role = presentationRole(child.role);
    let line = `${stateIcon(state)} ${child.taskId}${role !== undefined && role.length > 0 ? ` [${role}]` : ""}`;
    if (state !== "complete") {
      line += `: ${displayLabel(state)}`;
    }
    const reason = shortReason(child);
    if (reason !== undefined && reason.length > 0) {
      line += ` · ${reason}`;
    }
    if (child.sessionId !== undefined && child.sessionId.length > 0) {
      line += ` · session ${child.sessionId}`;
    }
    if (child.error && state !== "complete") {
      line += ` · ${child.error.message}`;
    }
    lines.push(line);
  }
  appendSuccessfulSummaries(lines, orderedResults(result.results));
  return lines.join("\n");
};

const renderChildSelectionDetails = (
  result: ChildResult,
  theme: Theme
): string[] => {
  const details: string[] = [];
  if (result.selection?.model) {
    details.push(
      theme.fg(
        "muted",
        `model: ${result.selection.model.provider}/${result.selection.model.id}`
      )
    );
  }
  if (result.selection?.thinkingLevel) {
    details.push(
      theme.fg("muted", `thinking: ${result.selection.thinkingLevel}`)
    );
  }
  if (result.selection?.modelSource) {
    details.push(
      theme.fg("muted", `model selection: ${result.selection.modelSource}`)
    );
  }
  if (result.selection?.thinkingSource) {
    details.push(
      theme.fg(
        "muted",
        `thinking selection: ${result.selection.thinkingSource}`
      )
    );
  }
  if (result.sessionId !== undefined && result.sessionId.length > 0) {
    details.push(theme.fg("muted", `session: ${result.sessionId}`));
  }
  return details;
};

const renderChildDetails = (
  state: ChildDisplayState,
  result: ChildResult,
  location: string | undefined,
  theme: Theme
): string[] => {
  const details: string[] = [];
  if (
    state === "complete" &&
    result.summary !== undefined &&
    result.summary.length > 0
  ) {
    details.push(theme.fg("toolOutput", result.summary));
  }
  if (state === "complete" && result.truncated) {
    details.push(theme.fg("muted", "summary truncated"));
  }
  if (
    (state === "needs_input" || state === "incomplete") &&
    result.error?.message !== undefined &&
    result.error.message.length > 0
  ) {
    details.push(theme.fg("error", result.error.message));
  }
  if (
    location !== undefined &&
    location.length > 0 &&
    state !== "needs_input"
  ) {
    details.push(theme.fg("muted", `location: ${location}`));
  }
  details.push(...renderChildSelectionDetails(result, theme));
  return details;
};

const renderChild = (
  taskId: string,
  requestedRole: string | undefined,
  result: ChildResult | undefined,
  expanded: boolean,
  theme: Theme
): string => {
  const state = childDisplayState(result);
  const role = presentationRole(requestedRole);
  let line = `${theme.fg(stateColor(state), stateIcon(state))} ${theme.fg("toolTitle", taskId)}${role !== undefined && role.length > 0 ? theme.fg("muted", ` [${role}]`) : ""}`;
  if (state !== "complete") {
    line += ` ${theme.fg(stateColor(state), displayLabel(state))}`;
  }
  const reason = result && shortReason(result);
  if (state === "incomplete" && reason !== undefined && reason.length > 0) {
    line += theme.fg("muted", ` · ${reason}`);
  }
  const location =
    result && !result.paneClosed ? locationText(result) : undefined;
  if (
    state === "needs_input" &&
    location !== undefined &&
    location.length > 0
  ) {
    line += theme.fg("muted", ` · ${location}`);
  }
  if (!expanded || !result) {
    return line;
  }

  const details = renderChildDetails(state, result, location, theme);
  return details.length ? `${line}\n${details.join("\n")}` : line;
};

const displayDetails = (
  value: SpawnPiDisplayDetails | SpawnBatchResult | undefined,
  isPartial: boolean
): SpawnPiDisplayDetails | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if ("phase" in value) {
    return value;
  }
  return isPartial ? undefined : { phase: "finished", result: value };
};

const requestedTasks = (value: {
  tasks?: SpawnTask[];
}): SpawnTask[] | undefined => value.tasks;

const rawText = (
  content: readonly { type: string; text?: string }[]
): string => {
  const text = content.find((part) => part.type === "text");
  return text?.text ?? "spawn_pi finished";
};

const taskCountLabel = (count: number): string => {
  const task = count === 1 ? "task" : "tasks";
  return ` ${count} ${task}`;
};

export const registerSpawnPiTool = (
  pi: ExtensionAPI,
  runner: BatchRunner,
  getParentLabel: () => string,
  configResult: ChildRolesConfigLoadResult
): void => {
  const guidance = configResult.ok
    ? roleGuidance(configResult.config)
    : undefined;
  pi.registerTool<typeof SpawnPiSchema, SpawnPiDisplayDetails>({
    description:
      "Run bounded tasks concurrently in fresh visible Pi sessions hosted by Herdr. This call blocks the Parent until all children settle.",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!configResult.ok) {
        throw new Error(
          `Invalid Child Roles config at ${configResult.path}: ${configResult.error}`
        );
      }
      const result = await runner.run(
        { tasks: params.tasks },
        {
          cwd: ctx.cwd,
          model: ctx.model
            ? { id: ctx.model.id, provider: ctx.model.provider }
            : undefined,
          parentLabel: getParentLabel(),
          thinkingLevel: ctx.thinkingLevel,
        },
        {
          availableModels: ctx.modelRegistry
            .getAvailable()
            .map((model) => ({ id: model.id, provider: model.provider })),
          config: configResult.config,
        },
        {
          onProgress(progress) {
            onUpdate?.({
              content: [{ text: summarizeProgress(progress), type: "text" }],
              details: {
                phase: "working",
                progress,
              } satisfies SpawnPiDisplayDetails,
            });
          },
          signal,
        }
      );
      return {
        content: [{ text: summarize(result), type: "text" }],
        details: { phase: "finished", result } satisfies SpawnPiDisplayDetails,
      };
    },
    label: "Spawn Pi",
    name: "spawn_pi",
    parameters: SpawnPiSchema,
    promptGuidelines: [
      "Children created by spawn_pi share the current checkout, may interfere with concurrent edits, and cannot invoke spawn_pi.",
      "Set task.role only to an exact name listed under Configured Child Roles; otherwise omit role.",
      "Omit task.thinking by default so configured or inherited reasoning effort applies. Override it only when the user requests a level or the task cannot succeed without a different level.",
      ...(guidance !== undefined && guidance.length > 0 ? [guidance] : []),
    ],
    promptSnippet: "Run bounded child tasks in fresh visible Pi sessions",
    renderCall(args, theme) {
      const tasks = requestedTasks(args);
      const count = tasks?.length;
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_pi")) +
          (count === undefined
            ? ""
            : theme.fg("accent", taskCountLabel(count))),
        0,
        0
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = displayDetails(result.details, isPartial);
      if (!details) {
        return new Text(rawText(result.content), 0, 0);
      }

      const tasks = requestedTasks(context.args);
      const progress =
        details.phase === "working" ? details.progress : undefined;
      const batch = details.phase === "finished" ? details.result : undefined;
      const total = progress?.total ?? batch?.requested ?? tasks?.length ?? 0;
      const settled = new Map<number, ChildResult>();
      for (const childResult of progress?.results ?? batch?.results ?? []) {
        settled.set(childResult.requestIndex, childResult);
      }
      const state = batchDisplayState(details);
      const header =
        details.phase === "working"
          ? `working · ${details.progress.completed} of ${details.progress.total} settled`
          : `${stateIcon(state)} ${finalBatchStatus(details.result, state)}`;
      const lines = [theme.fg(stateColor(state), header)];
      for (let requestIndex = 0; requestIndex < total; requestIndex += 1) {
        const task = tasks?.[requestIndex];
        lines.push(
          renderChild(
            taskIdFor(requestIndex),
            task?.role,
            settled.get(requestIndex),
            expanded,
            theme
          )
        );
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
};
