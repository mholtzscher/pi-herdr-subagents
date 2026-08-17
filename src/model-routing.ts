import { readFileSync, readdirSync } from "node:fs";
import nodePath from "node:path";

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
  timeoutSeconds?: number | false;
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

export type ChildRuntimeResolution =
  | { ok: true; selection: ChildRuntimeSelection }
  | ChildRuntimeFailure;

interface ConfigObject {
  readonly [key: string]: ConfigInput;
}

type ConfigInput =
  | string
  | number
  | boolean
  | null
  | ConfigInput[]
  | ConfigObject;

interface RoleFrontmatter {
  description?: string;
  model?: ConfiguredModel;
  thinking?: ChildThinkingLevel;
}

class ConfigSourceError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ConfigSourceError";
    this.path = path;
  }
}

interface Selection<T> {
  value: T | undefined;
  source?: SelectionSource;
}

const ObjectSchema = Type.Object({}, { additionalProperties: true });
const ArraySchema = Type.Array(Type.Unknown());
const PlacementSchema = Type.Union([
  Type.Literal("tab"),
  Type.Literal("split"),
]);
const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const MAX_TIMEOUT_SECONDS = 2_147_483;
export const DEFAULT_TIMEOUT_SECONDS = 600;

const THINKING_LEVELS: readonly ChildThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const isMissing = (error: Error): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const nonWhitespace = (value: ConfigInput): value is string =>
  Check(Type.String(), value) && value.trim().length > 0;

const parseModel = (value: string): ModelReference | undefined => {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) {
    return undefined;
  }
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (
    !nonWhitespace(provider) ||
    !nonWhitespace(id) ||
    provider !== provider.trim() ||
    id !== id.trim()
  ) {
    return undefined;
  }
  return { id, provider };
};

const select = <T>(
  explicit: T | undefined,
  role: T | undefined,
  defaults: T | undefined,
  parent: T | undefined
): Selection<T> => {
  if (explicit !== undefined) {
    return { source: "explicit", value: explicit };
  }
  if (role !== undefined) {
    return { source: "role", value: role };
  }
  if (defaults !== undefined) {
    return { source: "default", value: defaults };
  }
  return parent === undefined
    ? { value: undefined }
    : { source: "parent", value: parent };
};

const withoutRolePrompt = (
  selection: ChildRuntimeSelection
): Omit<ChildRuntimeSelection, "rolePrompt"> => {
  const { rolePrompt: _, ...visible } = selection;
  return visible;
};

const isConfigObject = (cause: unknown): cause is ConfigObject =>
  typeof cause === "object" &&
  cause !== null &&
  !Array.isArray(cause) &&
  Check(ObjectSchema, cause);

const parseObject = (cause: unknown, name: string): ConfigObject => {
  if (!isConfigObject(cause)) {
    throw new Error(`${name} must be an object`);
  }
  return cause;
};

const rejectUnsupported = (
  value: ConfigObject,
  supported: string[],
  name: string
): void => {
  for (const key of Object.keys(value)) {
    if (!supported.includes(key)) {
      throw new Error(`${name}.${key} is not supported`);
    }
  }
};

const parseNonWhitespace = (
  value: ConfigInput | undefined,
  name: string
): string => {
  if (value === undefined || !nonWhitespace(value)) {
    throw new Error(`${name} must be a non-whitespace string`);
  }
  return value;
};

const validatePlacement = (
  value: ConfigInput,
  name: string
): ChildPlacement => {
  if (!Check(PlacementSchema, value)) {
    throw new Error(`${name} must be tab or split`);
  }
  return value;
};

const validateModelReference = (value: ConfigInput, name: string): string => {
  if (!nonWhitespace(value) || value !== value.trim() || !parseModel(value)) {
    throw new Error(`${name} must be an exact provider/model-id`);
  }
  return value;
};

const validateModel = (value: ConfigInput, name: string): ConfiguredModel => {
  if (Check(ArraySchema, value)) {
    if (!value.length) {
      throw new Error(
        `${name} must be a non-empty array of exact provider/model-id strings`
      );
    }
    return value.map((candidate, index) =>
      validateModelReference(candidate, `${name}[${index}]`)
    );
  }
  return validateModelReference(value, name);
};

const validateThinking = (
  value: ConfigInput,
  name: string
): ChildThinkingLevel => {
  if (!Check(ThinkingLevelSchema, value)) {
    throw new Error(`${name} must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return value;
};

const validateTimeoutSeconds = (
  value: ConfigInput,
  name: string
): number | false => {
  if (value === false) {
    return false;
  }
  if (
    !Check(Type.Integer({ maximum: MAX_TIMEOUT_SECONDS, minimum: 1 }), value)
  ) {
    throw new Error(
      `${name} must be false or a positive integer no greater than ${MAX_TIMEOUT_SECONDS}`
    );
  }
  return value;
};

const parseOrchestrator = (value: ConfigInput): OrchestratorConfig => {
  const orchestrator = parseObject(value, "orchestrator");
  rejectUnsupported(orchestrator, ["enabled"], "orchestrator");
  if (!Check(Type.Boolean(), orchestrator.enabled)) {
    throw new Error("orchestrator.enabled must be a boolean");
  }
  return { enabled: orchestrator.enabled };
};

const parseDefaults = (value: ConfigInput, name: string): ChildDefaults => {
  const defaults = parseObject(value, name);
  rejectUnsupported(
    defaults,
    ["placement", "model", "thinking", "timeoutSeconds"],
    name
  );
  const result: ChildDefaults = { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  if (defaults.placement !== undefined) {
    result.placement = validatePlacement(
      defaults.placement,
      `${name}.placement`
    );
  }
  if (defaults.model !== undefined) {
    result.model = validateModel(defaults.model, `${name}.model`);
  }
  if (defaults.thinking !== undefined) {
    result.thinking = validateThinking(defaults.thinking, `${name}.thinking`);
  }
  if (defaults.timeoutSeconds !== undefined) {
    result.timeoutSeconds = validateTimeoutSeconds(
      defaults.timeoutSeconds,
      `${name}.timeoutSeconds`
    );
  }
  return result;
};

const parseConfig = (
  cause: unknown,
  rolesPath: string
): Omit<HerdrSubagentsConfig, "roles"> => {
  const config = parseObject(cause, "config");
  if (Object.hasOwn(config, "roles")) {
    throw new Error(
      `config.roles is no longer supported; move each role to ${nodePath.join(rolesPath, "<name>.md")}`
    );
  }
  rejectUnsupported(config, ["orchestrator", "defaults"], "config");
  const orchestrator =
    config.orchestrator === undefined
      ? { enabled: false }
      : parseOrchestrator(config.orchestrator);
  const defaults =
    config.defaults === undefined
      ? { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS }
      : parseDefaults(config.defaults, "defaults");
  return { defaults, orchestrator };
};

const rolesDirectoryFor = (configPath: string): string => {
  const extension = nodePath.extname(configPath);
  const basePath = extension
    ? configPath.slice(0, -extension.length)
    : configPath;
  return nodePath.join(basePath, "roles");
};

const parseRoleFrontmatter = (
  value: ConfigObject | null | undefined,
  name: string
): RoleFrontmatter => {
  if (value === null || value === undefined) {
    return {};
  }
  const metadata = parseObject(value, name);
  rejectUnsupported(metadata, ["description", "model", "thinking"], name);
  const result: RoleFrontmatter = {};
  if (metadata.description !== undefined) {
    result.description = parseNonWhitespace(
      metadata.description,
      `${name}.description`
    );
  }
  if (metadata.model !== undefined) {
    result.model = validateModel(metadata.model, `${name}.model`);
  }
  if (metadata.thinking !== undefined) {
    result.thinking = validateThinking(metadata.thinking, `${name}.thinking`);
  }
  return result;
};

const parseRoleDocument = (
  contents: string,
  sourcePath: string
): RoleFrontmatter & { prompt: string } => {
  let frontmatter: RoleFrontmatter = {};
  let prompt = contents;
  let openingLength = 0;
  if (contents.startsWith("---\r\n")) {
    openingLength = 5;
  } else if (contents.startsWith("---\n")) {
    openingLength = 4;
  } else if (contents === "---") {
    openingLength = 3;
  }

  if (openingLength) {
    let lineStart = openingLength;
    let closingStart = -1;
    let bodyStart = -1;
    while (lineStart <= contents.length) {
      const newline = contents.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? contents.length : newline;
      const line = contents.slice(lineStart, lineEnd).replace(/\r$/u, "");
      if (line === "---") {
        closingStart = lineStart;
        bodyStart = newline === -1 ? contents.length : newline + 1;
        break;
      }
      if (newline === -1) {
        break;
      }
      lineStart = newline + 1;
    }
    if (closingStart === -1) {
      throw new Error(`Unterminated YAML frontmatter in ${sourcePath}`);
    }
    const document = parseYamlDocument(
      contents.slice(openingLength, closingStart),
      {
        customTags: [],
        uniqueKeys: true,
        version: "1.2",
      }
    );
    const yamlProblem = document.errors[0] ?? document.warnings[0];
    if (yamlProblem !== undefined) {
      throw yamlProblem;
    }
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    if (value !== null && value !== undefined && !isConfigObject(value)) {
      throw new Error("frontmatter must be an object");
    }
    frontmatter = parseRoleFrontmatter(value, "frontmatter");
    prompt = contents.slice(bodyStart);
  }

  return {
    ...frontmatter,
    prompt: parseNonWhitespace(prompt.trim(), "prompt"),
  };
};

const loadRolesDirectory = (
  directoryPath: string
): Record<string, ChildRole> => {
  let entries;
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && isMissing(error)) {
      return {};
    }
    throw new ConfigSourceError(directoryPath, error);
  }

  const roles: [string, ChildRole][] = [];
  const sortedEntries: typeof entries = [];
  for (const entry of entries) {
    const index = sortedEntries.findIndex(
      (existing) => entry.name < existing.name
    );
    if (index === -1) {
      sortedEntries.push(entry);
    } else {
      sortedEntries.splice(index, 0, entry);
    }
  }
  for (const entry of sortedEntries) {
    if (
      (!entry.isFile() && !entry.isSymbolicLink()) ||
      !entry.name.endsWith(".md")
    ) {
      continue;
    }
    const name = entry.name.slice(0, -3);
    const documentPath = nodePath.join(directoryPath, entry.name);
    try {
      if (!nonWhitespace(name)) {
        throw new Error("role names must be non-whitespace strings");
      }
      roles.push([
        name,
        parseRoleDocument(readFileSync(documentPath, "utf-8"), documentPath),
      ]);
    } catch (error) {
      throw new ConfigSourceError(documentPath, error);
    }
  }
  return Object.fromEntries(roles);
};

const selectAvailableModel = (
  choice: Selection<ConfiguredModel>,
  availableModels: readonly ModelReference[]
): ModelReference | undefined => {
  if (choice.value === undefined) {
    return undefined;
  }
  const candidates = Array.isArray(choice.value)
    ? choice.value
    : [choice.value];
  if (choice.source === "parent") {
    return parseModel(candidates[0]);
  }
  return candidates
    .map(parseModel)
    .find(
      (candidate): candidate is ModelReference =>
        candidate !== undefined &&
        availableModels.some(
          (model) =>
            model.provider === candidate.provider && model.id === candidate.id
        )
    );
};

export const loadChildRolesConfig = (
  configPath = nodePath.join(getAgentDir(), "herdr-subagents.json")
): ChildRolesConfigLoadResult => {
  const rolesPath = rolesDirectoryFor(configPath);
  let globalConfig: Omit<HerdrSubagentsConfig, "roles"> = {
    defaults: { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS },
    orchestrator: { enabled: false },
  };

  try {
    const value: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    globalConfig = parseConfig(value, rolesPath);
  } catch (error) {
    if (!(error instanceof Error) || !isMissing(error)) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        path: configPath,
      };
    }
  }

  try {
    return {
      config: { ...globalConfig, roles: loadRolesDirectory(rolesPath) },
      ok: true,
      path: configPath,
    };
  } catch (error) {
    const source = error instanceof ConfigSourceError ? error.path : rolesPath;
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      path: source,
    };
  }
};

export const resolveChildRuntime = (input: {
  task: SpawnTask;
  parent: ParentContext;
  routing: ModelRoutingContext;
}): ChildRuntimeResolution => {
  const roleName = input.task.role;
  const hasRole =
    roleName !== undefined &&
    Object.hasOwn(input.routing.config.roles, roleName);
  const role = hasRole ? input.routing.config.roles[roleName] : undefined;
  if (roleName !== undefined && !hasRole) {
    return {
      code: "role_not_found",
      message: `Child role ${JSON.stringify(roleName)} is not configured`,
      ok: false,
    };
  }

  const modelChoice = select<ConfiguredModel>(
    input.task.model,
    role?.model,
    input.routing.config.defaults.model,
    input.parent.model &&
      `${input.parent.model.provider}/${input.parent.model.id}`
  );
  const selectedModel = selectAvailableModel(
    modelChoice,
    input.routing.availableModels
  );
  const thinkingChoice = select(
    input.task.thinking,
    role?.thinking,
    input.routing.config.defaults.thinking,
    input.parent.thinkingLevel
  );
  const selection: ChildRuntimeSelection = {};
  if (selectedModel) {
    selection.model = selectedModel;
    selection.modelSource = modelChoice.source;
  }
  if (thinkingChoice.value !== undefined && thinkingChoice.value.length > 0) {
    selection.thinkingLevel = thinkingChoice.value;
    selection.thinkingSource = thinkingChoice.source;
  }
  if (role) {
    selection.rolePrompt = role.prompt;
  }

  if (
    modelChoice.value !== undefined &&
    (Array.isArray(modelChoice.value) || modelChoice.value.length > 0) &&
    !selectedModel
  ) {
    const visibleSelection = withoutRolePrompt(selection);
    if (modelChoice.source === "role") {
      const {
        model: _,
        modelSource: __,
        ...redactedSelection
      } = visibleSelection;
      const failure: ChildRuntimeFailure = {
        code: "model_routing_failed",
        message:
          "The model configured for the requested Child role is not available",
        ok: false,
      };
      if (Object.keys(redactedSelection).length) {
        failure.selection = redactedSelection;
      }
      return failure;
    }
    const failure: ChildRuntimeFailure = {
      code: "model_routing_failed",
      message: Array.isArray(modelChoice.value)
        ? "The configured default Child model is not available"
        : `Requested Child model ${modelChoice.value} is not available`,
      ok: false,
    };
    if (Object.keys(visibleSelection).length) {
      failure.selection = visibleSelection;
    }
    return failure;
  }
  return { ok: true, selection };
};

export const roleGuidance = (config: ChildRolesConfig): string | undefined => {
  const roles = Object.entries(config.roles);
  if (!roles.length) {
    return undefined;
  }
  return `Configured Child Roles: ${roles
    .map(([name, role]) =>
      role.description !== undefined && role.description.length > 0
        ? `${name} (${role.description})`
        : name
    )
    .join("; ")}`;
};

export const emptyChildRolesConfig = (): ChildRolesConfig => ({
  defaults: { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS },
  roles: {},
});
