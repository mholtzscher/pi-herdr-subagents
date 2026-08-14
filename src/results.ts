import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { TaskId } from "./domain.js";

export interface ChildResultSummary {
  summary: string;
  truncated: boolean;
}

export interface ChildResultReader {
  read(input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }): Promise<ChildResultSummary>;
}

const TextContentSchema = Type.String();
const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ContentBlocksSchema = Type.Array(Type.Unknown());
const EntryMessageSchema = Type.Object({
  role: Type.Optional(Type.String()),
  content: Type.Optional(Type.Unknown()),
});
const EntrySchema = Type.Object({
  id: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  type: Type.Optional(Type.String()),
  message: Type.Optional(EntryMessageSchema),
});
type Entry = Static<typeof EntrySchema>;
type EntryMessage = Static<typeof EntryMessageSchema>;

export class ResultAttributionError extends Error {}

export class JsonlChildResultReader implements ChildResultReader {
  async read(input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }): Promise<ChildResultSummary> {
    let raw: string;
    try {
      raw = await readFile(input.sessionPath, "utf8");
    } catch (error) {
      throw new ResultAttributionError(`Unable to read child session: ${messageOf(error)}`);
    }

    const entries = parseEntries(raw);
    const marker = `<!-- pi-herdr-task:${input.taskId} -->`;
    const marked = entries.filter((entry) => entry.message?.role === "user" && textOf(entry.message).includes(marker));
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

    const summary = textOf(answer.message);
    if (!summary) throw new ResultAttributionError("Final assistant response has no text");
    return truncate(summary, input.maxChars);
  }
}

function parseEntries(raw: string): Entry[] {
  const lines = raw.split("\n").filter(Boolean);
  try {
    return lines.map(parseEntry).filter((entry) => entry.type !== "session");
  } catch {
    throw new ResultAttributionError("Child session contains malformed JSONL");
  }
}

function parseEntry(line: string): Entry {
  const entry: unknown = JSON.parse(line);
  if (!Check(EntrySchema, entry)) throw new ResultAttributionError("Child session contains malformed JSONL");
  return entry;
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

function textOf(message: EntryMessage): string {
  const { content } = message;
  if (Check(TextContentSchema, content)) return content;
  if (!Check(ContentBlocksSchema, content)) return "";
  return content
    .filter((block) => Check(TextBlockSchema, block))
    .map((block) => block.text)
    .join("");
}

function truncate(value: string, maxChars: number): ChildResultSummary {
  if (value.length <= maxChars) return { summary: value, truncated: false };
  return { summary: value.slice(0, maxChars), truncated: true };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
