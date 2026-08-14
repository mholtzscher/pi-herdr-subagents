import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("loads global config and role catalogue independently", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "custom.config.json");
  const rolesPath = join(directory, "custom.config", "roles");
  try {
    assert.deepEqual(loadChildRolesConfig(path), {
      ok: true,
      path,
      config: { orchestrator: { enabled: false }, defaults: {}, roles: {} },
    });

    mkdirSync(rolesPath, { recursive: true });
    writeFileSync(join(rolesPath, "body-only.md"), "\n  Investigate.\n\n- Keep evidence.\n  ");
    writeFileSync(join(rolesPath, "scalar.md"), "---\nmodel: provider/one\n---\nScalar prompt");
    writeFileSync(join(rolesPath, "empty-metadata.md"), "---\n---\nEmpty metadata prompt");
    writeFileSync(
      join(rolesPath, "explore.md"),
      [
        "---",
        "description: Read-only exploration",
        "model:",
        "  - provider/first",
        "  - provider/a/b",
        "thinking: low",
        "---",
        "",
        "Explore the repository.",
      ].join("\n"),
    );
    let loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.orchestrator.enabled, false);
      assert.deepEqual(loaded.config.roles["body-only"], { prompt: "Investigate.\n\n- Keep evidence." });
      assert.deepEqual(loaded.config.roles.scalar, { model: "provider/one", prompt: "Scalar prompt" });
      assert.deepEqual(loaded.config.roles["empty-metadata"], { prompt: "Empty metadata prompt" });
      assert.deepEqual(loaded.config.roles.explore, {
        description: "Read-only exploration",
        model: ["provider/first", "provider/a/b"],
        thinking: "low",
        prompt: "Explore the repository.",
      });
    }

    writeFileSync(path, JSON.stringify({ orchestrator: { enabled: true }, defaults: { model: "provider/a/b" } }));
    loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.orchestrator.enabled, true);
      assert.equal(loaded.config.defaults.model, "provider/a/b");
      assert.equal(loaded.config.roles.explore.prompt, "Explore the repository.");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovers only sorted direct regular exact-.md files", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "herdr-subagents.json");
  const rolesPath = join(directory, "herdr-subagents", "roles");
  try {
    mkdirSync(join(rolesPath, "nested"), { recursive: true });
    mkdirSync(join(rolesPath, "directory.md"));
    writeFileSync(join(rolesPath, "z.md"), "Z prompt");
    writeFileSync(join(rolesPath, "a.md"), "A prompt");
    writeFileSync(join(rolesPath, "ignored.MD"), "ignored");
    writeFileSync(join(rolesPath, "nested", "nested.md"), "ignored");
    symlinkSync(join(rolesPath, "a.md"), join(rolesPath, "link.md"));

    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(Object.keys(loaded.config.roles), ["a", "z"]);

    writeFileSync(join(rolesPath, "b.md"), "---\nunknown: true\n---\nPrompt");
    writeFileSync(join(rolesPath, "0.md"), "---\nunknown: true\n---\nPrompt");
    const invalid = loadChildRolesConfig(path);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.path, join(rolesPath, "0.md"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid role documents and identifies their source", () => {
  const cases: [string, RegExp][] = [
    ["   \n", /prompt/],
    ["---\ndescription: nope\nPrompt", /Unterminated/],
    ["---\n[broken\n---\nPrompt", /Flow sequence|YAML/],
    ["---\ndescription: one\ndescription: two\n---\nPrompt", /Map keys must be unique/],
    ["---\nmetadata\n---\nPrompt", /frontmatter must be an object/],
    ["---\nunknown: true\n---\nPrompt", /not supported/],
    ["---\ndescription: !custom value\n---\nPrompt", /tag|Tag/],
    ["---\ndescription: '   '\n---\nPrompt", /non-whitespace/],
    ["---\nmodel: []\n---\nPrompt", /non-empty array/],
    ["---\nmodel: provider\n---\nPrompt", /exact provider\/model-id/],
    ["---\nthinking: huge\n---\nPrompt", /must be one of/],
  ];

  for (const [contents, expected] of cases) {
    const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
    const path = join(directory, "herdr-subagents.json");
    const documentPath = join(directory, "herdr-subagents", "roles", "explore.md");
    try {
      mkdirSync(join(directory, "herdr-subagents", "roles"), { recursive: true });
      writeFileSync(documentPath, contents);
      const loaded = loadChildRolesConfig(path);
      assert.equal(loaded.ok, false);
      if (!loaded.ok) {
        assert.equal(loaded.path, documentPath);
        assert.match(loaded.error, expected);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("validates global config and reports the JSON roles migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "herdr-subagents.json");
  try {
    for (const model of [[], [""], [42], [" provider/model"], ["provider/model "], ["provider"], ["/model"]]) {
      writeFileSync(path, JSON.stringify({ defaults: { model } }));
      assert.match(errorOf(loadChildRolesConfig(path)), /exact provider\/model-id|non-empty array/);
    }
    for (const orchestrator of [true, {}, { enabled: "yes" }, { enabled: true, prompt: "no" }]) {
      writeFileSync(path, JSON.stringify({ orchestrator }));
      assert.match(errorOf(loadChildRolesConfig(path)), /orchestrator/);
    }
    writeFileSync(path, JSON.stringify({ roles: { explore: { prompt: "Explore." } } }));
    assert.match(
      errorOf(loadChildRolesConfig(path)),
      /config\.roles is no longer supported.*herdr-subagents\/roles\/<name>\.md/,
    );
    writeFileSync(path, JSON.stringify({ defaults: { prompt: "no" } }));
    assert.match(errorOf(loadChildRolesConfig(path)), /not supported/);
    writeFileSync(path, "{");
    const malformed = loadChildRolesConfig(path);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.path, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a whitespace-only filename-derived role name", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "herdr-subagents.json");
  const documentPath = join(directory, "herdr-subagents", "roles", "   .md");
  try {
    mkdirSync(join(directory, "herdr-subagents", "roles"), { recursive: true });
    writeFileSync(documentPath, "Prompt");
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.equal(loaded.path, documentPath);
      assert.match(loaded.error, /role names/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports an unreadable catalogue path", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-roles-"));
  const path = join(directory, "herdr-subagents.json");
  const rolesPath = join(directory, "herdr-subagents", "roles");
  try {
    mkdirSync(join(directory, "herdr-subagents"));
    writeFileSync(rolesPath, "not a directory");
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.path, rolesPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loads the shipped global config and role examples", () => {
  const path = join(process.cwd(), "herdr-subagents.example.json");
  const loaded = loadChildRolesConfig(path);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(Object.keys(loaded.config.roles), ["explore", "reviewer", "worker"]);
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
