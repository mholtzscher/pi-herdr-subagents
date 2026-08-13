import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ChildRuntimeSelection, ChildThinkingLevel, ModelReference, ParentContext, SpawnTask } from "./domain.js";

export type ConfiguredModel = string | string[];

export interface ChildRuntimeDefaults {
  model?: ConfiguredModel;
  thinking?: ChildThinkingLevel;
}

export interface ChildRole extends ChildRuntimeDefaults {
  description?: string;
  prompt: string;
}

export interface ChildRolesConfig {
  defaults: ChildRuntimeDefaults;
  roles: Record<string, ChildRole>;
}

export type ChildRolesConfigLoadResult =
  | { ok: true; path: string; config: ChildRolesConfig }
  | { ok: false; path: string; error: string };

export interface ModelRoutingContext {
  config: ChildRolesConfig;
  availableModels: readonly ModelReference[];
}

export type ChildRuntimeResolution =
  | { ok: true; selection: ChildRuntimeSelection }
  | {
      ok: false;
      code: "role_not_found" | "model_routing_failed";
      message: string;
      selection?: Omit<ChildRuntimeSelection, "rolePrompt">;
    };

const THINKING_LEVELS = new Set<ChildThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function loadChildRolesConfig(path = join(getAgentDir(), "herdr-subagents.json")): ChildRolesConfigLoadResult {
  if (!existsSync(path)) return { ok: true, path, config: { defaults: {}, roles: {} } };
  try {
    return { ok: true, path, config: parseConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveChildRuntime(input: {
  task: SpawnTask;
  parent: ParentContext;
  routing: ModelRoutingContext;
}): ChildRuntimeResolution {
  const roleName = input.task.role;
  const hasRole = roleName !== undefined && Object.prototype.hasOwnProperty.call(input.routing.config.roles, roleName);
  const role = hasRole ? input.routing.config.roles[roleName] : undefined;
  if (roleName !== undefined && !hasRole) {
    return { ok: false, code: "role_not_found", message: `Child role ${JSON.stringify(roleName)} is not configured` };
  }

  const modelChoice = select<ConfiguredModel>(input.task.model, role?.model, input.routing.config.defaults.model, input.parent.model && `${input.parent.model.provider}/${input.parent.model.id}`);
  const selectedModel = selectAvailableModel(modelChoice, input.routing.availableModels);
  const thinkingChoice = select(input.task.thinking, role?.thinking, input.routing.config.defaults.thinking, input.parent.thinkingLevel);
  const selection: ChildRuntimeSelection = {
    ...(selectedModel ? { model: selectedModel, modelSource: modelChoice.source } : {}),
    ...(thinkingChoice.value ? { thinkingLevel: thinkingChoice.value, thinkingSource: thinkingChoice.source } : {}),
    ...(role ? { rolePrompt: role.prompt } : {}),
  };

  if (modelChoice.value && !selectedModel) {
    const visibleSelection = withoutRolePrompt(selection);
    if (modelChoice.source === "role") {
      const { model: _, modelSource: __, ...redactedSelection } = visibleSelection;
      return {
        ok: false,
        code: "model_routing_failed",
        message: "The model configured for the requested Child role is not available",
        ...(Object.keys(redactedSelection).length ? { selection: redactedSelection } : {}),
      };
    }
    return {
      ok: false,
      code: "model_routing_failed",
      message: Array.isArray(modelChoice.value)
        ? "The configured default Child model is not available"
        : `Requested Child model ${modelChoice.value} is not available`,
      ...(Object.keys(visibleSelection).length ? { selection: visibleSelection } : {}),
    };
  }
  return { ok: true, selection };
}

export function roleGuidance(config: ChildRolesConfig): string | undefined {
  const roles = Object.entries(config.roles);
  if (!roles.length) return undefined;
  return `Configured Child Roles: ${roles.map(([name, role]) => role.description ? `${name} (${role.description})` : name).join("; ")}`;
}

function parseConfig(value: unknown): ChildRolesConfig {
  if (!isRecord(value)) throw new Error("config must be an object");
  rejectUnsupported(value, ["defaults", "roles"], "config");
  const defaults = value.defaults === undefined ? {} : parseDefaults(value.defaults, "defaults");
  if (value.roles !== undefined && !isRecord(value.roles)) throw new Error("roles must be an object");
  const roles = Object.fromEntries(Object.entries(value.roles ?? {}).map(([name, role]) => {
    if (!nonWhitespace(name)) throw new Error("role names must be non-whitespace strings");
    return [name, parseRole(role, `roles.${JSON.stringify(name)}`)];
  }));
  return { defaults, roles };
}

function parseDefaults(value: unknown, name: string): ChildRuntimeDefaults {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  rejectUnsupported(value, ["model", "thinking"], name);
  return {
    ...(value.model === undefined ? {} : { model: validateModel(value.model, `${name}.model`) }),
    ...(value.thinking === undefined ? {} : { thinking: validateThinking(value.thinking, `${name}.thinking`) }),
  };
}

function parseRole(value: unknown, name: string): ChildRole {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  rejectUnsupported(value, ["description", "prompt", "model", "thinking"], name);
  if (!nonWhitespace(value.prompt)) throw new Error(`${name}.prompt must be a non-whitespace string`);
  if (value.description !== undefined && !nonWhitespace(value.description)) throw new Error(`${name}.description must be a non-whitespace string`);
  return {
    prompt: value.prompt,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.model === undefined ? {} : { model: validateModel(value.model, `${name}.model`) }),
    ...(value.thinking === undefined ? {} : { thinking: validateThinking(value.thinking, `${name}.thinking`) }),
  };
}

function validateModel(value: unknown, name: string): ConfiguredModel {
  if (Array.isArray(value)) {
    if (!value.length) throw new Error(`${name} must be a non-empty array of exact provider/model-id strings`);
    return value.map((candidate, index) => validateModelReference(candidate, `${name}[${index}]`));
  }
  return validateModelReference(value, name);
}

function validateModelReference(value: unknown, name: string): string {
  if (!nonWhitespace(value) || value !== value.trim() || !parseModel(value)) throw new Error(`${name} must be an exact provider/model-id`);
  return value;
}

function validateThinking(value: unknown, name: string): ChildThinkingLevel {
  if (typeof value !== "string" || !THINKING_LEVELS.has(value as ChildThinkingLevel)) throw new Error(`${name} must be one of ${Array.from(THINKING_LEVELS).join(", ")}`);
  return value as ChildThinkingLevel;
}

function parseModel(value: string): ModelReference | undefined {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  return nonWhitespace(provider) && nonWhitespace(id) && provider === provider.trim() && id === id.trim() ? { provider, id } : undefined;
}

function selectAvailableModel(
  choice: { value: ConfiguredModel | undefined; source?: "explicit" | "role" | "default" | "parent" },
  availableModels: readonly ModelReference[],
): ModelReference | undefined {
  if (choice.value === undefined) return undefined;
  const candidates = Array.isArray(choice.value) ? choice.value : [choice.value];
  if (choice.source === "parent") return parseModel(candidates[0]);
  return candidates.map(parseModel).find((candidate): candidate is ModelReference =>
    candidate !== undefined && availableModels.some((model) => model.provider === candidate.provider && model.id === candidate.id),
  );
}

function select<T>(explicit: T | undefined, role: T | undefined, defaults: T | undefined, parent: T | undefined): { value: T | undefined; source?: "explicit" | "role" | "default" | "parent" } {
  if (explicit !== undefined) return { value: explicit, source: "explicit" };
  if (role !== undefined) return { value: role, source: "role" };
  if (defaults !== undefined) return { value: defaults, source: "default" };
  return parent === undefined ? { value: undefined } : { value: parent, source: "parent" };
}

function withoutRolePrompt(selection: ChildRuntimeSelection): Omit<ChildRuntimeSelection, "rolePrompt"> {
  const { rolePrompt: _, ...visible } = selection;
  return visible;
}

function rejectUnsupported(value: Record<string, unknown>, supported: string[], name: string): void {
  for (const key of Object.keys(value)) if (!supported.includes(key)) throw new Error(`${name}.${key} is not supported`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonWhitespace(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function emptyChildRolesConfig(): ChildRolesConfig {
  return { defaults: {}, roles: {} };
}
