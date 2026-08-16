import { readFile } from "node:fs/promises";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import type { TaskId } from "./domain.js";

export interface ChildResultSummary {
  summary: string;
  truncated: boolean;
}

export interface ChildResultReader {
  read: (input: {
    sessionPath: string;
    taskId: TaskId;
    baselineEntryId?: string;
    maxChars: number;
  }) => Promise<ChildResultSummary>;
}

const TextContentSchema = Type.String();
const TextBlockSchema = Type.Object({
  text: Type.String(),
  type: Type.Literal("text"),
});
const ContentBlocksSchema = Type.Array(Type.Unknown());
const EntryMessageSchema = Type.Object({
  content: Type.Optional(Type.Unknown()),
  role: Type.Optional(Type.String()),
});
const EntrySchema = Type.Object({
  id: Type.Optional(Type.String()),
  message: Type.Optional(EntryMessageSchema),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  type: Type.Optional(Type.String()),
});
type Entry = Static<typeof EntrySchema>;
type EntryMessage = Static<typeof EntryMessageSchema>;

export class ResultAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultAttributionError";
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const parseEntry = (line: string): Entry => {
  const entry: unknown = JSON.parse(line);
  if (!Check(EntrySchema, entry)) {
    throw new ResultAttributionError("Child session contains malformed JSONL");
  }
  return entry;
};

const parseEntries = (raw: string): Entry[] => {
  const lines = raw.split("\n").filter(Boolean);
  try {
    return lines.map(parseEntry).filter((entry) => entry.type !== "session");
  } catch {
    throw new ResultAttributionError("Child session contains malformed JSONL");
  }
};

const textOf = (message: EntryMessage): string => {
  const { content } = message;
  if (Check(TextContentSchema, content)) {
    return content;
  }
  if (!Check(ContentBlocksSchema, content)) {
    return "";
  }
  return content
    .filter((block) => Check(TextBlockSchema, block))
    .map((block) => block.text)
    .join("");
};

const descendsFrom = (
  id: string,
  ancestorId: string,
  entries: Map<string, Entry>
): boolean => {
  const seen = new Set<string>();
  let current: string | null | undefined = id;
  while (current !== null && current !== undefined) {
    if (seen.has(current)) {
      throw new ResultAttributionError("Session ancestry contains a cycle");
    }
    seen.add(current);
    if (current === ancestorId) {
      return true;
    }
    current = entries.get(current)?.parentId;
  }
  return false;
};

const truncate = (value: string, maxChars: number): ChildResultSummary => {
  if (value.length <= maxChars) {
    return { summary: value, truncated: false };
  }
  return { summary: value.slice(0, maxChars), truncated: true };
};

const findTaskEntryId = (entries: Entry[], taskId: TaskId): string => {
  const marker = `<!-- pi-herdr-task:${taskId} -->`;
  const marked = entries.filter(
    (entry) =>
      entry.message?.role === "user" && textOf(entry.message).includes(marker)
  );
  if (marked.length !== 1) {
    throw new ResultAttributionError("Task marker is missing or ambiguous");
  }
  const [task] = marked;
  if (task?.id === undefined || task.id.length === 0) {
    throw new ResultAttributionError("Task marker is missing or ambiguous");
  }
  return task.id;
};

const indexEntries = (entries: Entry[]): Map<string, Entry> => {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.id === undefined || entry.id.length === 0 || byId.has(entry.id)) {
      throw new ResultAttributionError("Session ancestry is malformed");
    }
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (
      entry.parentId !== null &&
      entry.parentId !== undefined &&
      !byId.has(entry.parentId)
    ) {
      throw new ResultAttributionError("Session ancestry is malformed");
    }
  }
  return byId;
};

const validateBaseline = (
  taskEntryId: string,
  baselineEntryId: string | undefined,
  byId: Map<string, Entry>
): void => {
  if (baselineEntryId === undefined || baselineEntryId.length === 0) {
    return;
  }
  if (!byId.has(baselineEntryId)) {
    throw new ResultAttributionError("Session baseline is missing");
  }
  if (
    !descendsFrom(taskEntryId, baselineEntryId, byId) ||
    taskEntryId === baselineEntryId
  ) {
    throw new ResultAttributionError(
      "Task marker does not follow the recorded session baseline"
    );
  }
};

const readResult: ChildResultReader["read"] = async (input) => {
  let raw: string;
  try {
    raw = await readFile(input.sessionPath, "utf-8");
  } catch (error) {
    throw new ResultAttributionError(
      `Unable to read child session: ${messageOf(error)}`
    );
  }

  const entries = parseEntries(raw);
  const taskEntryId = findTaskEntryId(entries, input.taskId);
  const byId = indexEntries(entries);
  validateBaseline(taskEntryId, input.baselineEntryId, byId);

  const descendants = entries.filter(
    (entry) =>
      entry.id !== undefined &&
      entry.id.length > 0 &&
      descendsFrom(entry.id, taskEntryId, byId)
  );
  if (
    descendants.some(
      (entry) => entry.id !== taskEntryId && entry.message?.role === "user"
    )
  ) {
    throw new ResultAttributionError(
      "Manual user input interleaved with the child task"
    );
  }
  const answers = descendants.filter(
    (entry) => entry.message?.role === "assistant"
  );
  const answer = answers.at(-1);
  if (!answer?.message) {
    throw new ResultAttributionError(
      "No final assistant response descends from the task marker"
    );
  }

  const summary = textOf(answer.message);
  if (!summary) {
    throw new ResultAttributionError("Final assistant response has no text");
  }
  return truncate(summary, input.maxChars);
};

// oxlint-disable-next-line eslint/max-classes-per-file
export class JsonlChildResultReader implements ChildResultReader {
  // oxlint-disable-next-line eslint/class-methods-use-this
  async read(
    input: Parameters<ChildResultReader["read"]>[0]
  ): ReturnType<ChildResultReader["read"]> {
    return await readResult(input);
  }
}
