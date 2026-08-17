import assert from "node:assert/strict";
import test from "node:test";

import {
  childPrompt,
  RequestValidationError,
  taskIdFor,
  validateSpawnBatchRequest,
} from "../../src/domain.js";

void test("validates the fixed task limit and prompt", () => {
  validateSpawnBatchRequest({
    tasks: [{ prompt: "inspect" }, { prompt: "test" }],
  });
  assert.throws(() => {
    validateSpawnBatchRequest({ tasks: [] });
  }, RequestValidationError);
  assert.throws(() => {
    validateSpawnBatchRequest({ tasks: [{ prompt: "   " }] });
  }, RequestValidationError);
  validateSpawnBatchRequest({
    tasks: Array.from({ length: 8 }, () => ({ prompt: "x" })),
  });
  assert.throws(() => {
    validateSpawnBatchRequest({
      tasks: Array.from({ length: 9 }, () => ({ prompt: "x" })),
    });
  }, RequestValidationError);
  validateSpawnBatchRequest({
    tasks: [
      {
        model: "provider/model/with/slash",
        prompt: "inspect",
        role: "explore",
        thinking: "low",
      },
    ],
  });
  assert.throws(() => {
    validateSpawnBatchRequest({
      tasks: [{ prompt: "inspect", role: "   " }],
    });
  }, RequestValidationError);
  assert.throws(() => {
    validateSpawnBatchRequest({
      tasks: [{ model: "provider-only", prompt: "inspect" }],
    });
  }, RequestValidationError);
  const requestWithMultipleModels = { tasks: [{ prompt: "inspect" }] };
  Object.assign(requestWithMultipleModels.tasks[0], {
    model: ["provider/first", "provider/second"],
  });
  assert.throws(() => {
    validateSpawnBatchRequest(requestWithMultipleModels);
  }, RequestValidationError);
});

void test("builds the exact task marker envelope", () => {
  const id = taskIdFor(0);
  assert.match(
    childPrompt(id, { prompt: "Inspect src" }),
    /<!-- pi-herdr-task:task-1 -->/u
  );
  const prompt = childPrompt(id, { prompt: "Inspect src" });
  assert.match(prompt, /Inspect src/u);
  assert.match(
    prompt,
    /respect any configured Child role, including read-only constraints/u
  );
  assert.match(prompt, /Do only the delegated task/u);
  assert.match(prompt, /Do not broaden the investigation/u);
  assert.match(prompt, /modify files outside your stated ownership/u);
  assert.match(prompt, /cannot be completed within scope/u);
  assert.match(prompt, /report the blocker and stop/u);
});
