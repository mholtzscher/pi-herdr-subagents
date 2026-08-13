import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { BatchRunner } from "./batch.js";
import type { BatchProgress, SpawnBatchResult } from "./domain.js";
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

export function registerSpawnPiTool(
  pi: ExtensionAPI,
  runner: BatchRunner,
  getParentLabel: () => string,
  configResult: ChildRolesConfigLoadResult,
): void {
  pi.registerTool({
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
      const renderProgress = (progress: BatchProgress) => {
        onUpdate?.({
          content: [{ type: "text", text: `spawn_pi: ${progress.completed}/${progress.total} children settled` }],
          details: { progress },
        });
      };
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
        { signal, onProgress: renderProgress },
      );
      return {
        content: [{ type: "text", text: summarize(result) }],
        details: result,
      };
    },
    renderCall(args, theme) {
      const roles = args.tasks.map((task) => task.role).filter((role): role is string => Boolean(role));
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_pi ")) +
          theme.fg("accent", `${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}`) +
          (roles.length ? theme.fg("muted", `  ${roles.join(", ")}`) : ""),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SpawnBatchResult | undefined;
      if (!details)
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "spawn_pi finished", 0, 0);
      const lines = details.results.map((child) => {
        const icon = child.status === "succeeded" ? theme.fg("success", "✓") : theme.fg("warning", "•");
        let line = `${icon} ${theme.fg("toolTitle", child.taskId)} ${child.status}`;
        if (child.sessionId) line += theme.fg("muted", `  ${child.sessionId}`);
        if (!child.paneClosed && child.location)
          line += theme.fg("muted", `  ${child.location.tabId}/${child.location.paneId}`);
        if (child.role) line += theme.fg("muted", `  role:${child.role}`);
        if (child.selection?.model)
          line += theme.fg("muted", `  ${child.selection.model.provider}/${child.selection.model.id}`);
        if (child.selection?.thinkingLevel) line += theme.fg("muted", `  thinking:${child.selection.thinkingLevel}`);
        if (expanded && (child.selection?.modelSource || child.selection?.thinkingSource))
          line += theme.fg(
            "muted",
            ` (${[child.selection.modelSource && `model:${child.selection.modelSource}`, child.selection.thinkingSource && `thinking:${child.selection.thinkingSource}`].filter(Boolean).join(", ")})`,
          );
        if (expanded && child.summary) line += `\n${theme.fg("toolOutput", child.summary)}`;
        if (child.error) line += `\n${theme.fg("error", child.error.message)}`;
        return line;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

function summarize(result: SpawnBatchResult): string {
  const succeeded = result.results.filter((child) => child.status === "succeeded").length;
  const lines = [`spawn_pi: ${succeeded}/${result.requested} attributed result${succeeded === 1 ? "" : "s"}`];
  for (const child of result.results) {
    lines.push(
      `${child.taskId}: ${child.status}${child.sessionId ? ` (session ${child.sessionId})` : ""}${child.error ? `: ${child.error.message}` : ""}`,
    );
  }
  return lines.join("\n");
}
