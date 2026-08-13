export type TaskId = string & { readonly __brand: "TaskId" };
export type ChildPlacement = "tab" | "split";
export type ChildThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SelectionSource = "explicit" | "role" | "default" | "parent";

export interface ModelReference {
  provider: string;
  id: string;
}

export interface SpawnTask {
  prompt: string;
  placement?: ChildPlacement;
  role?: string;
  model?: string;
  thinking?: ChildThinkingLevel;
}

export interface SpawnBatchRequest {
  tasks: SpawnTask[];
}

export type ChildStatus = "succeeded" | "failed" | "blocked" | "unattributable" | "parent_aborted";

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
  results: ChildResult[];
}

export class RequestValidationError extends Error {}

const THINKING_LEVELS = new Set<ChildThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function validateSpawnBatchRequest(request: SpawnBatchRequest): void {
  if (!Array.isArray(request.tasks) || request.tasks.length < 1 || request.tasks.length > 8) {
    throw new RequestValidationError("tasks must contain between 1 and 8 tasks");
  }
  request.tasks.forEach((task, index) => {
    if (!task || typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
      throw new RequestValidationError(`tasks[${index}].prompt must be non-empty`);
    }
    if (task.placement !== undefined && task.placement !== "tab" && task.placement !== "split") {
      throw new RequestValidationError(`tasks[${index}].placement must be tab or split`);
    }
    if (task.role !== undefined && (typeof task.role !== "string" || task.role.trim().length === 0)) {
      throw new RequestValidationError(`tasks[${index}].role must be non-empty`);
    }
    if (task.model !== undefined && !isCanonicalModel(task.model)) {
      throw new RequestValidationError(`tasks[${index}].model must be an exact provider/model-id`);
    }
    if (task.thinking !== undefined && !THINKING_LEVELS.has(task.thinking)) {
      throw new RequestValidationError(`tasks[${index}].thinking must be a supported thinking level`);
    }
  });
}

function isCanonicalModel(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  return provider === provider.trim() && id === id.trim() && provider.length > 0 && id.length > 0;
}

export function taskIdFor(index: number): TaskId {
  return `task-${index + 1}` as TaskId;
}

export function childPrompt(taskId: TaskId, task: SpawnTask): string {
  return `<!-- pi-herdr-task:${taskId} -->\nYou are a fresh Pi instance handling one bounded task for a Parent Pi.\n\nTask:\n${task.prompt}\n\nOperate in the current checkout and respect any configured Child role, including read-only constraints. Other Pi instances may be working concurrently.\nReturn a concise final answer containing:\n- what you found or changed;\n- verification performed;\n- unresolved issues or interference observed.`;
}
