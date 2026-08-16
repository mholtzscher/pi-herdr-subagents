import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { taskIdFor } from "../../src/domain.js";
import {
  JsonlChildResultReader,
  ResultAttributionError,
} from "../../src/results.js";

const session = async (lines: unknown[]): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-herdr-results-"));
  const sessionPath = path.join(dir, "child.jsonl");
  await writeFile(
    sessionPath,
    lines.map((line) => JSON.stringify(line)).join("\n")
  );
  return sessionPath;
};

const header = { id: "session", type: "session" };
const task = {
  id: "u1",
  message: { content: "<!-- pi-herdr-task:task-1 -->\nTask", role: "user" },
  parentId: null,
  type: "message",
};

void test("reads the final assistant descendant and truncates it", async () => {
  const sessionPath = await session([
    header,
    task,
    {
      id: "a1",
      message: {
        content: [{ text: "first", type: "text" }],
        role: "assistant",
      },
      parentId: "u1",
      type: "message",
    },
    {
      id: "t1",
      message: { content: [], role: "toolResult" },
      parentId: "a1",
      type: "message",
    },
    {
      id: "a2",
      message: {
        content: [{ text: "final answer", type: "text" }],
        role: "assistant",
      },
      parentId: "t1",
      type: "message",
    },
  ]);
  const result = await new JsonlChildResultReader().read({
    maxChars: 5,
    sessionPath,
    taskId: taskIdFor(0),
  });
  assert.deepEqual(result, { summary: "final", truncated: true });
});

void test("rejects manual interleaving and malformed ancestry", async () => {
  const reader = new JsonlChildResultReader();
  const interleaved = await session([
    header,
    task,
    {
      id: "u2",
      message: { content: "manual", role: "user" },
      parentId: "u1",
      type: "message",
    },
    {
      id: "a1",
      message: { content: "answer", role: "assistant" },
      parentId: "u2",
      type: "message",
    },
  ]);
  await assert.rejects(async () => {
    await reader.read({
      maxChars: 20_000,
      sessionPath: interleaved,
      taskId: taskIdFor(0),
    });
  }, ResultAttributionError);
  const badParent = await session([
    header,
    task,
    {
      id: "a1",
      message: { content: "answer", role: "assistant" },
      parentId: "missing",
      type: "message",
    },
  ]);
  await assert.rejects(async () => {
    await reader.read({
      maxChars: 20_000,
      sessionPath: badParent,
      taskId: taskIdFor(0),
    });
  }, ResultAttributionError);
});
