import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type {
  ChildRuntimeSelection,
  ChildThinkingLevel,
  ModelReference,
  ParentContext,
  SelectionSource,
  SpawnTask,
} from "./domain.js";

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

interface OrchestratorConfig {
  enabled: boolean;
}

export interface HerdrSubagentsConfig extends ChildRolesConfig {
  orchestrator: OrchestratorConfig;
}

export type ChildRolesConfigLoadResult =
  | { ok: true; path: string; config: HerdrSubagentsConfig }
  | { ok: false; path: string; error: string };

export interface ModelRoutingContext {
  config: ChildRolesConfig;
  availableModels: readonly ModelReference[];
}

interface ChildRuntimeFailure {
  ok: false;
  code: "role_not_found" | "model_routing_failed";
  message: string;
  selection?: Omit<ChildRuntimeSelection, "rolePrompt">;
}

export type ChildRuntimeResolution = { ok: true; selection: ChildRuntimeSelection } | ChildRuntimeFailure;

interface ConfigObject {
  readonly [key: string]: ConfigInput;
}

type ConfigInput = string | number | boolean | null | ConfigInput[] | ConfigObject;

interface Selection<T> {
  value: T | undefined;
  source?: SelectionSource;
}

const ObjectSchema = Type.Object({}, { additionalProperties: true });
const ArraySchema = Type.Array(Type.Unknown());
const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const THINKING_LEVELS: readonly ChildThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function loadChildRolesConfig(path = join(getAgentDir(), "herdr-subagents.json")): ChildRolesConfigLoadResult {
  if (!existsSync(path))
    return { ok: true, path, config: { orchestrator: { enabled: false }, defaults: {}, roles: {} } };
  try {
    const value: ConfigInput = JSON.parse(readFileSync(path, "utf8"));
    return { ok: true, path, config: parseConfig(value) };
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

  const modelChoice = select<ConfiguredModel>(
    input.task.model,
    role?.model,
    input.routing.config.defaults.model,
    input.parent.model && `${input.parent.model.provider}/${input.parent.model.id}`,
  );
  const selectedModel = selectAvailableModel(modelChoice, input.routing.availableModels);
  const thinkingChoice = select(
    input.task.thinking,
    role?.thinking,
    input.routing.config.defaults.thinking,
    input.parent.thinkingLevel,
  );
  const selection: ChildRuntimeSelection = {};
  if (selectedModel) {
    selection.model = selectedModel;
    selection.modelSource = modelChoice.source;
  }
  if (thinkingChoice.value) {
    selection.thinkingLevel = thinkingChoice.value;
    selection.thinkingSource = thinkingChoice.source;
  }
  if (role) selection.rolePrompt = role.prompt;

  if (modelChoice.value && !selectedModel) {
    const visibleSelection = withoutRolePrompt(selection);
    if (modelChoice.source === "role") {
      const { model: _, modelSource: __, ...redactedSelection } = visibleSelection;
      const failure: ChildRuntimeFailure = {
        ok: false,
        code: "model_routing_failed",
        message: "The model configured for the requested Child role is not available",
      };
      if (Object.keys(redactedSelection).length) failure.selection = redactedSelection;
      return failure;
    }
    const failure: ChildRuntimeFailure = {
      ok: false,
      code: "model_routing_failed",
      message: Array.isArray(modelChoice.value)
        ? "The configured default Child model is not available"
        : `Requested Child model ${modelChoice.value} is not available`,
    };
    if (Object.keys(visibleSelection).length) failure.selection = visibleSelection;
    return failure;
  }
  return { ok: true, selection };
}

export function roleGuidance(config: ChildRolesConfig): string | undefined {
  const roles = Object.entries(config.roles);
  if (!roles.length) return undefined;
  return `Configured Child Roles: ${roles.map(([name, role]) => (role.description ? `${name} (${role.description})` : name)).join("; ")}`;
}

function parseConfig(value: ConfigInput): HerdrSubagentsConfig {
  const config = parseObject(value, "config");
  rejectUnsupported(config, ["orchestrator", "defaults", "roles"], "config");
  const orchestrator = config.orchestrator === undefined ? { enabled: false } : parseOrchestrator(config.orchestrator);
  const defaults = config.defaults === undefined ? {} : parseDefaults(config.defaults, "defaults");
  const roles = config.roles === undefined ? {} : parseRoles(config.roles);
  return { orchestrator, defaults, roles };
}

function parseOrchestrator(value: ConfigInput): OrchestratorConfig {
  const orchestrator = parseObject(value, "orchestrator");
  rejectUnsupported(orchestrator, ["enabled"], "orchestrator");
  if (!Check(Type.Boolean(), orchestrator.enabled)) throw new Error("orchestrator.enabled must be a boolean");
  return { enabled: orchestrator.enabled };
}

function parseDefaults(value: ConfigInput, name: string): ChildRuntimeDefaults {
  const defaults = parseObject(value, name);
  rejectUnsupported(defaults, ["model", "thinking"], name);
  const result: ChildRuntimeDefaults = {};
  if (defaults.model !== undefined) result.model = validateModel(defaults.model, `${name}.model`);
  if (defaults.thinking !== undefined) result.thinking = validateThinking(defaults.thinking, `${name}.thinking`);
  return result;
}

function parseRoles(value: ConfigInput): Record<string, ChildRole> {
  const roles = parseObject(value, "roles");
  return Object.fromEntries(
    Object.entries(roles).map(([name, role]) => {
      if (!nonWhitespace(name)) throw new Error("role names must be non-whitespace strings");
      return [name, parseRole(role, `roles.${JSON.stringify(name)}`)];
    }),
  );
}

function parseRole(value: ConfigInput, name: string): ChildRole {
  const role = parseObject(value, name);
  rejectUnsupported(role, ["description", "prompt", "model", "thinking"], name);
  const result: ChildRole = { prompt: parseNonWhitespace(role.prompt, `${name}.prompt`) };
  if (role.description !== undefined) result.description = parseNonWhitespace(role.description, `${name}.description`);
  if (role.model !== undefined) result.model = validateModel(role.model, `${name}.model`);
  if (role.thinking !== undefined) result.thinking = validateThinking(role.thinking, `${name}.thinking`);
  return result;
}

function validateModel(value: ConfigInput, name: string): ConfiguredModel {
  if (Check(ArraySchema, value)) {
    if (!value.length) throw new Error(`${name} must be a non-empty array of exact provider/model-id strings`);
    return value.map((candidate, index) => validateModelReference(candidate, `${name}[${index}]`));
  }
  return validateModelReference(value, name);
}

function validateModelReference(value: ConfigInput, name: string): string {
  if (!nonWhitespace(value) || value !== value.trim() || !parseModel(value))
    throw new Error(`${name} must be an exact provider/model-id`);
  return value;
}

function validateThinking(value: ConfigInput, name: string): ChildThinkingLevel {
  if (!Check(ThinkingLevelSchema, value)) throw new Error(`${name} must be one of ${THINKING_LEVELS.join(", ")}`);
  return value;
}

function parseModel(value: string): ModelReference | undefined {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  return nonWhitespace(provider) && nonWhitespace(id) && provider === provider.trim() && id === id.trim()
    ? { provider, id }
    : undefined;
}

function selectAvailableModel(
  choice: Selection<ConfiguredModel>,
  availableModels: readonly ModelReference[],
): ModelReference | undefined {
  if (choice.value === undefined) return undefined;
  const candidates = Array.isArray(choice.value) ? choice.value : [choice.value];
  if (choice.source === "parent") return parseModel(candidates[0]);
  return candidates
    .map(parseModel)
    .find(
      (candidate): candidate is ModelReference =>
        candidate !== undefined &&
        availableModels.some((model) => model.provider === candidate.provider && model.id === candidate.id),
    );
}

function select<T>(
  explicit: T | undefined,
  role: T | undefined,
  defaults: T | undefined,
  parent: T | undefined,
): Selection<T> {
  if (explicit !== undefined) return { value: explicit, source: "explicit" };
  if (role !== undefined) return { value: role, source: "role" };
  if (defaults !== undefined) return { value: defaults, source: "default" };
  return parent === undefined ? { value: undefined } : { value: parent, source: "parent" };
}

function withoutRolePrompt(selection: ChildRuntimeSelection): Omit<ChildRuntimeSelection, "rolePrompt"> {
  const { rolePrompt: _, ...visible } = selection;
  return visible;
}

function parseObject(value: ConfigInput, name: string): ConfigObject {
  if (!Check(ObjectSchema, value)) throw new Error(`${name} must be an object`);
  // SAFETY: TypeBox verified that the JSON value is an object, and ConfigInput's only object member is ConfigObject.
  return value as ConfigObject;
}

function rejectUnsupported(value: ConfigObject, supported: string[], name: string): void {
  for (const key of Object.keys(value))
    if (!supported.includes(key)) throw new Error(`${name}.${key} is not supported`);
}

function nonWhitespace(value: ConfigInput): value is string {
  return Check(Type.String(), value) && value.trim().length > 0;
}

function parseNonWhitespace(value: ConfigInput | undefined, name: string): string {
  if (value === undefined || !nonWhitespace(value)) throw new Error(`${name} must be a non-whitespace string`);
  return value;
}

export function emptyChildRolesConfig(): ChildRolesConfig {
  return { defaults: {}, roles: {} };
}
