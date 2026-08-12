import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { taskIdFor } from "../../src/domain.js";
import { JsonlChildResultReader, ResultAttributionError } from "../../src/results.js";

async function session(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-results-"));
  const path = join(dir, "child.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n"));
  return path;
}

const header = { type: "session", id: "session" };
const task = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "<!-- pi-herdr-task:task-1 -->\nTask" } };

test("reads the final assistant descendant and truncates it", async () => {
  const path = await session([header, task, { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }, { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", content: [] } }, { type: "message", id: "a2", parentId: "t1", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }]);
  const result = await new JsonlChildResultReader().read({ sessionPath: path, taskId: taskIdFor(0), maxChars: 5 });
  assert.deepEqual(result, { summary: "final", truncated: true });
});

test("rejects manual interleaving and malformed ancestry", async () => {
  const reader = new JsonlChildResultReader();
  const interleaved = await session([header, task, { type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "manual" } }, { type: "message", id: "a1", parentId: "u2", message: { role: "assistant", content: "answer" } }]);
  await assert.rejects(() => reader.read({ sessionPath: interleaved, taskId: taskIdFor(0), maxChars: 20_000 }), ResultAttributionError);
  const badParent = await session([header, task, { type: "message", id: "a1", parentId: "missing", message: { role: "assistant", content: "answer" } }]);
  await assert.rejects(() => reader.read({ sessionPath: badParent, taskId: taskIdFor(0), maxChars: 20_000 }), ResultAttributionError);
});
