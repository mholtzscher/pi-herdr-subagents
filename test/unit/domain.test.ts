import assert from "node:assert/strict";
import test from "node:test";
import { childPrompt, RequestValidationError, taskIdFor, validateSpawnBatchRequest } from "../../src/domain.js";

test("validates the fixed task limit and prompt", () => {
  validateSpawnBatchRequest({ tasks: [{ prompt: "inspect" }, { prompt: "test", placement: "split" }] });
  assert.throws(() => validateSpawnBatchRequest({ tasks: [] }), RequestValidationError);
  assert.throws(() => validateSpawnBatchRequest({ tasks: [{ prompt: "   " }] }), RequestValidationError);
  validateSpawnBatchRequest({ tasks: Array.from({ length: 8 }, () => ({ prompt: "x" })) });
  assert.throws(() => validateSpawnBatchRequest({ tasks: Array.from({ length: 9 }, () => ({ prompt: "x" })) }), RequestValidationError);
  validateSpawnBatchRequest({ tasks: [{ prompt: "inspect", role: "explore", model: "provider/model/with/slash", thinking: "low" }] });
  assert.throws(() => validateSpawnBatchRequest({ tasks: [{ prompt: "inspect", role: "   " }] }), RequestValidationError);
  assert.throws(() => validateSpawnBatchRequest({ tasks: [{ prompt: "inspect", model: "provider-only" }] }), RequestValidationError);
});

test("builds the exact task marker envelope", () => {
  const id = taskIdFor(0);
  assert.match(childPrompt(id, { prompt: "Inspect src" }), /<!-- pi-herdr-task:task-1 -->/);
  assert.match(childPrompt(id, { prompt: "Inspect src" }), /Inspect src/);
});
