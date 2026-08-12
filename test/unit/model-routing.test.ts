import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadChildRolesConfig, resolveChildRuntime, roleGuidance } from "../../src/model-routing.js";

const parent = { cwd: "/repo", model: { provider: "parent", id: "unavailable" }, thinkingLevel: "high" as const };
const config = {
  defaults: { model: "default/model", thinking: "medium" as const },
  roles: {
    explore: { prompt: "Explore the repository.", description: "Read-only exploration", model: "role/model", thinking: "low" as const },
  },
};

function errorOf(result: ReturnType<typeof loadChildRolesConfig>): string {
  assert.equal(result.ok, false);
  return result.error;
}

function resolve(task: Parameters<typeof resolveChildRuntime>[0]["task"], availableModels = [
  { provider: "default", id: "model" },
  { provider: "role", id: "model" },
  { provider: "explicit", id: "nested/model" },
]) {
  return resolveChildRuntime({ task, parent, routing: { config, availableModels } });
}

test("loads missing config as empty and validates the complete config shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "herdr-subagents.json");
  try {
    assert.deepEqual(loadChildRolesConfig(path), { ok: true, path, config: { defaults: {}, roles: {} } });
    writeFileSync(path, JSON.stringify({ defaults: { model: "provider/a/b" }, roles: { explore: { prompt: "Explore." } } }));
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.config.defaults.model, "provider/a/b");

    writeFileSync(path, JSON.stringify({ roles: { "   ": { prompt: "Explore." } } }));
    assert.match(errorOf(loadChildRolesConfig(path)), /role names/);
    writeFileSync(path, JSON.stringify({ defaults: { prompt: "no" } }));
    assert.match(errorOf(loadChildRolesConfig(path)), /not supported/);
    writeFileSync(path, "{");
    assert.equal(loadChildRolesConfig(path).ok, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects role prompts that Pi could interpret as existing files", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const promptPath = join(directory, "prompt.txt");
  const configPath = join(directory, "herdr-subagents.json");
  try {
    writeFileSync(promptPath, "not a prompt");
    writeFileSync(configPath, JSON.stringify({ roles: { explore: { prompt: promptPath } } }));
    assert.match(errorOf(loadChildRolesConfig(configPath)), /existing local path/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves model and thinking independently with source metadata", () => {
  const routed = resolve({ prompt: "inspect", role: "explore", model: "explicit/nested/model" });
  assert.deepEqual(routed, {
    ok: true,
    selection: {
      model: { provider: "explicit", id: "nested/model" },
      modelSource: "explicit",
      thinkingLevel: "low",
      thinkingSource: "role",
      rolePrompt: "Explore the repository.",
    },
  });

  const defaults = resolve({ prompt: "inspect" });
  assert.equal(defaults.ok, true);
  if (defaults.ok) {
    assert.equal(defaults.selection.modelSource, "default");
    assert.equal(defaults.selection.thinkingSource, "default");
  }
});

test("does not validate inherited Parent model, but validates only the final selected route", () => {
  const inherited = resolveChildRuntime({
    task: { prompt: "inspect" },
    parent,
    routing: { config: { defaults: {}, roles: {} }, availableModels: [] },
  });
  assert.equal(inherited.ok, true);
  if (inherited.ok) assert.equal(inherited.selection.modelSource, "parent");

  const overridden = resolve({ prompt: "inspect", model: "explicit/nested/model" });
  assert.equal(overridden.ok, true);
  const unavailable = resolve({ prompt: "inspect", role: "explore", model: "missing/model" });
  assert.deepEqual(unavailable, {
    ok: false,
    code: "model_routing_failed",
    message: "Requested Child model missing/model is not available",
    selection: {
      model: { provider: "missing", id: "model" },
      modelSource: "explicit",
      thinkingLevel: "low",
      thinkingSource: "role",
    },
  });
});

test("keeps role prompts and model mappings out of guidance and routing errors", () => {
  const unknown = resolve({ prompt: "inspect", role: "missing" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "role_not_found");
  const guidance = roleGuidance(config)!;
  assert.match(guidance, /explore/);
  assert.match(guidance, /Read-only exploration/);
  assert.doesNotMatch(guidance, /Explore the repository|role\/model/);
});
