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
    explore: {
      prompt: "Explore the repository.",
      description: "Read-only exploration",
      model: "role/model",
      thinking: "low" as const,
    },
  },
};

function errorOf(result: ReturnType<typeof loadChildRolesConfig>): string {
  assert.equal(result.ok, false);
  return result.error;
}

function resolve(
  task: Parameters<typeof resolveChildRuntime>[0]["task"],
  availableModels = [
    { provider: "default", id: "model" },
    { provider: "role", id: "model" },
    { provider: "explicit", id: "nested/model" },
  ],
) {
  return resolveChildRuntime({ task, parent, routing: { config, availableModels } });
}

test("loads missing config as empty and validates the complete config shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "herdr-subagents.json");
  try {
    assert.deepEqual(loadChildRolesConfig(path), {
      ok: true,
      path,
      config: { orchestrator: { enabled: false }, defaults: {}, roles: {} },
    });
    writeFileSync(
      path,
      JSON.stringify({
        orchestrator: { enabled: true },
        defaults: { model: "provider/a/b" },
        roles: { explore: { prompt: "Explore.", model: ["provider/first", "provider/a/b"] } },
      }),
    );
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.orchestrator.enabled, true);
      assert.equal(loaded.config.defaults.model, "provider/a/b");
      assert.deepEqual(loaded.config.roles.explore.model, ["provider/first", "provider/a/b"]);
    }

    for (const model of [[], [""], [42], [" provider/model"], ["provider/model "], ["provider"], ["/model"]]) {
      writeFileSync(path, JSON.stringify({ defaults: { model } }));
      assert.match(errorOf(loadChildRolesConfig(path)), /exact provider\/model-id|non-empty array/);
    }
    writeFileSync(path, JSON.stringify({ roles: { explore: { prompt: "Explore.", model: [] } } }));
    assert.match(errorOf(loadChildRolesConfig(path)), /non-empty array/);

    for (const orchestrator of [true, {}, { enabled: "yes" }, { enabled: true, prompt: "no" }]) {
      writeFileSync(path, JSON.stringify({ orchestrator }));
      assert.match(errorOf(loadChildRolesConfig(path)), /orchestrator/);
    }

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

test("preserves literal role prompts that happen to name existing files", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const promptPath = join(directory, "prompt.txt");
  const configPath = join(directory, "herdr-subagents.json");
  try {
    writeFileSync(promptPath, "not a prompt");
    writeFileSync(configPath, JSON.stringify({ roles: { explore: { prompt: promptPath } } }));
    const loaded = loadChildRolesConfig(configPath);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.config.roles.explore.prompt, promptPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects inherited object properties as unknown roles", () => {
  for (const role of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    const resolution = resolve({ prompt: "inspect", role });
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.code, "role_not_found");
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

test("uses the first available candidate from the highest-precedence model layer", () => {
  const routed = resolveChildRuntime({
    task: { prompt: "inspect", role: "explore" },
    parent,
    routing: {
      config: {
        defaults: { model: ["default/missing", "default/model"] },
        roles: { explore: { prompt: "Explore.", model: ["role/missing", "role/a/b"] } },
      },
      availableModels: [
        { provider: "default", id: "model" },
        { provider: "role", id: "a/b" },
      ],
    },
  });
  assert.deepEqual(routed, {
    ok: true,
    selection: {
      model: { provider: "role", id: "a/b" },
      modelSource: "role",
      thinkingLevel: "high",
      thinkingSource: "parent",
      rolePrompt: "Explore.",
    },
  });

  const defaultRouted = resolveChildRuntime({
    task: { prompt: "inspect" },
    parent,
    routing: {
      config: { defaults: { model: ["default/missing", "default/model"] }, roles: {} },
      availableModels: [{ provider: "default", id: "model" }],
    },
  });
  assert.equal(defaultRouted.ok, true);
  if (defaultRouted.ok) assert.deepEqual(defaultRouted.selection.model, { provider: "default", id: "model" });
});

test("does not validate inherited Parent models or fall through unavailable chosen layers", () => {
  const inherited = resolveChildRuntime({
    task: { prompt: "inspect" },
    parent,
    routing: { config: { defaults: {}, roles: {} }, availableModels: [] },
  });
  assert.equal(inherited.ok, true);
  if (inherited.ok) assert.equal(inherited.selection.modelSource, "parent");

  const unavailableDefault = resolveChildRuntime({
    task: { prompt: "inspect" },
    parent,
    routing: {
      config: { defaults: { model: ["default/missing", "default/also-missing"] }, roles: {} },
      availableModels: [{ provider: "parent", id: "unavailable" }],
    },
  });
  assert.deepEqual(unavailableDefault, {
    ok: false,
    code: "model_routing_failed",
    message: "The configured default Child model is not available",
    selection: { thinkingLevel: "high", thinkingSource: "parent" },
  });
  assert.doesNotMatch(JSON.stringify(unavailableDefault), /default\/(missing|also-missing)/);

  const unavailable = resolve({ prompt: "inspect", role: "explore", model: "missing/model" });
  assert.deepEqual(unavailable, {
    ok: false,
    code: "model_routing_failed",
    message: "Requested Child model missing/model is not available",
    selection: { thinkingLevel: "low", thinkingSource: "role" },
  });
});

test("keeps role prompts and model mappings out of guidance and routing errors", () => {
  const unknown = resolve({ prompt: "inspect", role: "missing" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "role_not_found");

  const unavailableRoleModel = resolveChildRuntime({
    task: { prompt: "inspect", role: "explore" },
    parent,
    routing: {
      config: {
        defaults: {},
        roles: {
          explore: { prompt: "Explore the repository.", model: ["private/first", "private/model"], thinking: "low" },
        },
      },
      availableModels: [],
    },
  });
  assert.deepEqual(unavailableRoleModel, {
    ok: false,
    code: "model_routing_failed",
    message: "The model configured for the requested Child role is not available",
    selection: { thinkingLevel: "low", thinkingSource: "role" },
  });
  assert.doesNotMatch(JSON.stringify(unavailableRoleModel), /private\/(first|model)/);

  const guidance = roleGuidance(config)!;
  assert.match(guidance, /explore/);
  assert.match(guidance, /Read-only exploration/);
  assert.doesNotMatch(guidance, /Explore the repository|role\/model/);
});
