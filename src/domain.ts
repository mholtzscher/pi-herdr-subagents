export type TaskId = string & { readonly __brand: "TaskId" };
export type ChildPlacement = "tab" | "split";

export interface SpawnTask {
  prompt: string;
  placement?: ChildPlacement;
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
  error?: {
    code: "start_failed" | "prompt_failed" | "result_unreadable" | "blocked" | "parent_aborted";
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
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

export interface BatchProgress {
  completed: number;
  total: number;
  results: ChildResult[];
}

export class RequestValidationError extends Error {}

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
  });
}

export function taskIdFor(index: number): TaskId {
  return `task-${index + 1}` as TaskId;
}

export function childPrompt(taskId: TaskId, task: SpawnTask): string {
  return `<!-- pi-herdr-task:${taskId} -->\nYou are a fresh Pi instance handling one bounded task for a Parent Pi.\n\nTask:\n${task.prompt}\n\nWork directly in the current checkout. Other Pi instances may be working concurrently.\nReturn a concise final answer containing:\n- what you found or changed;\n- verification performed;\n- unresolved issues or interference observed.`;
}
