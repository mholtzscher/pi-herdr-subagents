import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseDocument as parseYamlDocument } from "yaml";
import type {
  ChildPlacement,
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

export interface ChildDefaults extends ChildRuntimeDefaults {
  placement?: ChildPlacement;
}

export interface ChildRole extends ChildRuntimeDefaults {
  description?: string;
  prompt: string;
}

export interface ChildRolesConfig {
  defaults: ChildDefaults;
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

interface RoleFrontmatter {
  description?: string;
  model?: ConfiguredModel;
  thinking?: ChildThinkingLevel;
}

class ConfigSourceError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

interface Selection<T> {
  value: T | undefined;
  source?: SelectionSource;
}

const ObjectSchema = Type.Object({}, { additionalProperties: true });
const ArraySchema = Type.Array(Type.Unknown());
const PlacementSchema = Type.Union([Type.Literal("tab"), Type.Literal("split")]);
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
  const rolesPath = rolesDirectoryFor(path);
  let globalConfig: Omit<HerdrSubagentsConfig, "roles"> = { orchestrator: { enabled: false }, defaults: {} };

  try {
    const value: ConfigInput = JSON.parse(readFileSync(path, "utf8"));
    globalConfig = parseConfig(value, rolesPath);
  } catch (error) {
    if (!(error instanceof Error) || !isMissing(error))
      return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    return { ok: true, path, config: { ...globalConfig, roles: loadRolesDirectory(rolesPath) } };
  } catch (error) {
    const source = error instanceof ConfigSourceError ? error.path : rolesPath;
    return { ok: false, path: source, error: error instanceof Error ? error.message : String(error) };
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

function rolesDirectoryFor(configPath: string): string {
  const extension = extname(configPath);
  return join(extension ? configPath.slice(0, -extension.length) : configPath, "roles");
}

function loadRolesDirectory(path: string): Record<string, ChildRole> {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return {};
    throw new ConfigSourceError(path, error);
  }

  const roles: [string, ChildRole][] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    const documentPath = join(path, entry.name);
    try {
      if (!nonWhitespace(name)) throw new Error("role names must be non-whitespace strings");
      roles.push([name, parseRoleDocument(readFileSync(documentPath, "utf8"), documentPath)]);
    } catch (error) {
      throw new ConfigSourceError(documentPath, error);
    }
  }
  return Object.fromEntries(roles);
}

function parseRoleDocument(contents: string, path: string): RoleFrontmatter & { prompt: string } {
  let frontmatter: RoleFrontmatter = {};
  let prompt = contents;
  const openingLength = contents.startsWith("---\r\n")
    ? 5
    : contents.startsWith("---\n")
      ? 4
      : contents === "---"
        ? 3
        : 0;

  if (openingLength) {
    let lineStart = openingLength;
    let closingStart = -1;
    let bodyStart = -1;
    while (lineStart <= contents.length) {
      const newline = contents.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? contents.length : newline;
      const line = contents.slice(lineStart, lineEnd).replace(/\r$/, "");
      if (line === "---") {
        closingStart = lineStart;
        bodyStart = newline === -1 ? contents.length : newline + 1;
        break;
      }
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    if (closingStart === -1) throw new Error(`Unterminated YAML frontmatter in ${path}`);
    const document = parseYamlDocument(contents.slice(openingLength, closingStart), {
      version: "1.2",
      uniqueKeys: true,
      customTags: [],
    });
    const yamlProblem = document.errors[0] ?? document.warnings[0];
    if (yamlProblem) throw yamlProblem;
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    if (value !== null && value !== undefined && !Check(ObjectSchema, value))
      throw new Error("frontmatter must be an object");
    // SAFETY: YAML returned nullish empty frontmatter or TypeBox verified an object with ConfigInput-compatible fields.
    frontmatter = parseRoleFrontmatter(value as ConfigObject | null | undefined, "frontmatter");
    prompt = contents.slice(bodyStart);
  }

  return { ...frontmatter, prompt: parseNonWhitespace(prompt.trim(), "prompt") };
}

function parseRoleFrontmatter(value: ConfigObject | null | undefined, name: string): RoleFrontmatter {
  if (value === null || value === undefined) return {};
  const metadata = parseObject(value, name);
  rejectUnsupported(metadata, ["description", "model", "thinking"], name);
  const result: RoleFrontmatter = {};
  if (metadata.description !== undefined)
    result.description = parseNonWhitespace(metadata.description, `${name}.description`);
  if (metadata.model !== undefined) result.model = validateModel(metadata.model, `${name}.model`);
  if (metadata.thinking !== undefined) result.thinking = validateThinking(metadata.thinking, `${name}.thinking`);
  return result;
}

function parseConfig(value: ConfigInput, rolesPath: string): Omit<HerdrSubagentsConfig, "roles"> {
  const config = parseObject(value, "config");
  if (Object.prototype.hasOwnProperty.call(config, "roles"))
    throw new Error(`config.roles is no longer supported; move each role to ${join(rolesPath, "<name>.md")}`);
  rejectUnsupported(config, ["orchestrator", "defaults"], "config");
  const orchestrator = config.orchestrator === undefined ? { enabled: false } : parseOrchestrator(config.orchestrator);
  const defaults = config.defaults === undefined ? {} : parseDefaults(config.defaults, "defaults");
  return { orchestrator, defaults };
}

function parseOrchestrator(value: ConfigInput): OrchestratorConfig {
  const orchestrator = parseObject(value, "orchestrator");
  rejectUnsupported(orchestrator, ["enabled"], "orchestrator");
  if (!Check(Type.Boolean(), orchestrator.enabled)) throw new Error("orchestrator.enabled must be a boolean");
  return { enabled: orchestrator.enabled };
}

function parseDefaults(value: ConfigInput, name: string): ChildDefaults {
  const defaults = parseObject(value, name);
  rejectUnsupported(defaults, ["placement", "model", "thinking"], name);
  const result: ChildDefaults = {};
  if (defaults.placement !== undefined) result.placement = validatePlacement(defaults.placement, `${name}.placement`);
  if (defaults.model !== undefined) result.model = validateModel(defaults.model, `${name}.model`);
  if (defaults.thinking !== undefined) result.thinking = validateThinking(defaults.thinking, `${name}.thinking`);
  return result;
}

function validatePlacement(value: ConfigInput, name: string): ChildPlacement {
  if (!Check(PlacementSchema, value)) throw new Error(`${name} must be tab or split`);
  return value;
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
  // SAFETY: TypeBox verified that the value is an object, and ConfigInput's only object member is ConfigObject.
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

function isMissing(error: Error): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function emptyChildRolesConfig(): ChildRolesConfig {
  return { defaults: {}, roles: {} };
}
