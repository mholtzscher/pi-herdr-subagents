import { Type } from "typebox";
import { Check } from "typebox/value";

export type TaskId = `task-${number}`;
export type ChildPlacement = "tab" | "split";
export type ChildThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type SelectionSource = "explicit" | "role" | "default" | "parent";

export interface ModelReference {
  provider: string;
  id: string;
}

export interface SpawnTask {
  prompt: string;
  role?: string;
  model?: string;
  thinking?: ChildThinkingLevel;
}

export interface SpawnBatchRequest {
  tasks: SpawnTask[];
}

export type ChildStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "unattributable"
  | "parent_aborted";

export interface ChildLocation {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface ChildRuntimeSelection {
  model?: ModelReference;
  modelSource?: SelectionSource;
  thinkingLevel?: ChildThinkingLevel;
  thinkingSource?: SelectionSource;
  rolePrompt?: string;
}

export interface ChildResult {
  taskId: TaskId;
  requestIndex: number;
  status: ChildStatus;
  summary?: string;
  truncated: boolean;
  sessionId?: string;
  sessionPath?: string;
  location?: ChildLocation;
  paneClosed: boolean;
  role?: string;
  selection?: Omit<ChildRuntimeSelection, "rolePrompt">;
  error?: {
    code:
      | "role_not_found"
      | "model_routing_failed"
      | "start_failed"
      | "prompt_failed"
      | "result_unreadable"
      | "blocked"
      | "parent_aborted";
    message: string;
  };
}

export interface SpawnBatchResult {
  requested: number;
  results: ChildResult[];
}

export interface ParentContext {
  cwd: string;
  parentLabel?: string;
  model?: ModelReference;
  thinkingLevel?: ChildThinkingLevel;
}

export interface BatchProgress {
  completed: number;
  total: number;
  /** Settled children only, in request order. */
  results: ChildResult[];
}

export class RequestValidationError extends Error {
  name = "RequestValidationError";
}

const TextSchema = Type.String();
const TaskSchema = Type.Object({ prompt: Type.Unknown() });
const ChildThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const isCanonicalModel = (value: string): boolean => {
  if (!Check(TextSchema, value) || value !== value.trim()) {
    return false;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return false;
  }
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  return (
    provider === provider.trim() &&
    id === id.trim() &&
    provider.length > 0 &&
    id.length > 0
  );
};

export const validateSpawnBatchRequest = (request: SpawnBatchRequest): void => {
  if (
    !Array.isArray(request.tasks) ||
    request.tasks.length < 1 ||
    request.tasks.length > 8
  ) {
    throw new RequestValidationError(
      "tasks must contain between 1 and 8 tasks"
    );
  }
  for (const [index, task] of request.tasks.entries()) {
    if (
      !Check(TaskSchema, task) ||
      !Check(TextSchema, task.prompt) ||
      task.prompt.trim().length === 0
    ) {
      throw new RequestValidationError(
        `tasks[${index}].prompt must be non-empty`
      );
    }
    if (
      task.role !== undefined &&
      (!Check(TextSchema, task.role) || task.role.trim().length === 0)
    ) {
      throw new RequestValidationError(
        `tasks[${index}].role must be non-empty`
      );
    }
    if (task.model !== undefined && !isCanonicalModel(task.model)) {
      throw new RequestValidationError(
        `tasks[${index}].model must be an exact provider/model-id`
      );
    }
    if (
      task.thinking !== undefined &&
      !Check(ChildThinkingLevelSchema, task.thinking)
    ) {
      throw new RequestValidationError(
        `tasks[${index}].thinking must be a supported thinking level`
      );
    }
  }
};

export const taskIdFor = (index: number): TaskId => `task-${index + 1}`;

export const childPrompt = (taskId: TaskId, task: SpawnTask): string =>
  `<!-- pi-herdr-task:${taskId} -->\nYou are a fresh Pi instance handling one bounded task for a Parent Pi.\n\nTask:\n${task.prompt}\n\nDo only the delegated task. Do not broaden the investigation, make adjacent improvements, or modify files outside your stated ownership. If the task cannot be completed within scope, report the blocker and stop.\nOperate in the current checkout and respect any configured Child role, including read-only constraints. Other Pi instances may be working concurrently.\nReturn a concise final answer containing:\n- what you found or changed;\n- verification performed;\n- unresolved issues or interference observed.`;
