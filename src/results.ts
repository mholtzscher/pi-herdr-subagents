import { readFile } from "node:fs/promises";
import type { TaskId } from "./domain.js";

export interface ChildResultReader {
  read(input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }): Promise<{ summary: string; truncated: boolean }>;
}

type Entry = {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

export class ResultAttributionError extends Error {}

export class JsonlChildResultReader implements ChildResultReader {
  async read(input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }): Promise<{ summary: string; truncated: boolean }> {
    let raw: string;
    try {
      raw = await readFile(input.sessionPath, "utf8");
    } catch (error) {
      throw new ResultAttributionError(`Unable to read child session: ${messageOf(error)}`);
    }

    const entries = parseEntries(raw);
    const marker = `<!-- pi-herdr-task:${input.taskId} -->`;
    const marked = entries.filter((entry) => entry.message?.role === "user" && textOf(entry.message.content).includes(marker));
    if (marked.length !== 1 || !marked[0].id) throw new ResultAttributionError("Task marker is missing or ambiguous");
    const task = marked[0];
    const taskEntryId = task.id!;

    const byId = new Map<string, Entry>();
    for (const entry of entries) {
      if (!entry.id || byId.has(entry.id)) throw new ResultAttributionError("Session ancestry is malformed");
      byId.set(entry.id, entry);
    }
    for (const entry of entries) {
      if (entry.parentId !== null && entry.parentId !== undefined && !byId.has(entry.parentId)) {
        throw new ResultAttributionError("Session ancestry is malformed");
      }
    }
    const baselineEntryId = input.baselineEntryId;
    if (baselineEntryId) {
      if (!byId.has(baselineEntryId)) throw new ResultAttributionError("Session baseline is missing");
      if (!descendsFrom(taskEntryId, baselineEntryId, byId) || taskEntryId === baselineEntryId) {
        throw new ResultAttributionError("Task marker does not follow the recorded session baseline");
      }
    }

    const descendants = entries.filter((entry) => entry.id && descendsFrom(entry.id, taskEntryId, byId));
    if (descendants.some((entry) => entry.id !== taskEntryId && entry.message?.role === "user")) {
      throw new ResultAttributionError("Manual user input interleaved with the child task");
    }
    const answers = descendants.filter((entry) => entry.message?.role === "assistant");
    const answer = answers.at(-1);
    if (!answer?.message) throw new ResultAttributionError("No final assistant response descends from the task marker");

    const summary = textOf(answer.message.content);
    if (!summary) throw new ResultAttributionError("Final assistant response has no text");
    return truncate(summary, input.maxChars);
  }
}

function parseEntries(raw: string): Entry[] {
  const lines = raw.split("\n").filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line) as Entry).filter((entry) => entry.type !== "session");
  } catch {
    throw new ResultAttributionError("Child session contains malformed JSONL");
  }
}

function descendsFrom(id: string, ancestorId: string, entries: Map<string, Entry>): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = id;
  while (current !== null && current !== undefined) {
    if (seen.has(current)) throw new ResultAttributionError("Session ancestry contains a cycle");
    seen.add(current);
    if (current === ancestorId) return true;
    current = entries.get(current)?.parentId;
  }
  return false;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function truncate(value: string, maxChars: number): { summary: string; truncated: boolean } {
  if (value.length <= maxChars) return { summary: value, truncated: false };
  return { summary: value.slice(0, maxChars), truncated: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
