import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import pathModule from "node:path";
import test from "node:test";

import {
  loadChildRolesConfig,
  resolveChildRuntime,
  roleGuidance,
} from "../../src/model-routing.js";

const parent = {
  cwd: "/repo",
  model: { id: "unavailable", provider: "parent" },
  thinkingLevel: "high" as const,
};
const config = {
  defaults: { model: "default/model", thinking: "medium" as const },
  roles: {
    explore: {
      description: "Read-only exploration",
      model: "role/model",
      prompt: "Explore the repository.",
      thinking: "low" as const,
    },
  },
};

const errorOf = (result: ReturnType<typeof loadChildRolesConfig>): string => {
  assert.equal(result.ok, false);
  return result.error;
};

const resolve = (
  task: Parameters<typeof resolveChildRuntime>[0]["task"],
  availableModels = [
    { id: "model", provider: "default" },
    { id: "model", provider: "role" },
    { id: "nested/model", provider: "explicit" },
  ]
) =>
  resolveChildRuntime({ parent, routing: { availableModels, config }, task });

void test("loads global config and role catalogue independently", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "custom.config.json");
  const rolesPath = pathModule.join(directory, "custom.config", "roles");
  try {
    assert.deepEqual(loadChildRolesConfig(path), {
      config: { defaults: {}, orchestrator: { enabled: false }, roles: {} },
      ok: true,
      path,
    });

    mkdirSync(rolesPath, { recursive: true });
    writeFileSync(
      pathModule.join(rolesPath, "body-only.md"),
      "\n  Investigate.\n\n- Keep evidence.\n  "
    );
    writeFileSync(
      pathModule.join(rolesPath, "scalar.md"),
      "---\nmodel: provider/one\n---\nScalar prompt"
    );
    writeFileSync(
      pathModule.join(rolesPath, "empty-metadata.md"),
      "---\n---\nEmpty metadata prompt"
    );
    writeFileSync(
      pathModule.join(rolesPath, "explore.md"),
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
      ].join("\n")
    );
    let loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.orchestrator.enabled, false);
      assert.deepEqual(loaded.config.roles["body-only"], {
        prompt: "Investigate.\n\n- Keep evidence.",
      });
      assert.deepEqual(loaded.config.roles.scalar, {
        model: "provider/one",
        prompt: "Scalar prompt",
      });
      assert.deepEqual(loaded.config.roles["empty-metadata"], {
        prompt: "Empty metadata prompt",
      });
      assert.deepEqual(loaded.config.roles.explore, {
        description: "Read-only exploration",
        model: ["provider/first", "provider/a/b"],
        prompt: "Explore the repository.",
        thinking: "low",
      });
    }

    writeFileSync(
      path,
      JSON.stringify({
        defaults: { model: "provider/a/b" },
        orchestrator: { enabled: true },
      })
    );
    loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.orchestrator.enabled, true);
      assert.equal(loaded.config.defaults.model, "provider/a/b");
      assert.equal(
        loaded.config.roles.explore.prompt,
        "Explore the repository."
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("discovers only sorted direct regular files and symlinks with exact .md names", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "herdr-subagents.json");
  const rolesPath = pathModule.join(directory, "herdr-subagents", "roles");
  try {
    mkdirSync(pathModule.join(rolesPath, "nested"), { recursive: true });
    mkdirSync(pathModule.join(rolesPath, "directory.md"));
    writeFileSync(pathModule.join(rolesPath, "z.md"), "Z prompt");
    writeFileSync(pathModule.join(rolesPath, "a.md"), "A prompt");
    writeFileSync(pathModule.join(rolesPath, "ignored.MD"), "ignored");
    writeFileSync(pathModule.join(rolesPath, "nested", "nested.md"), "ignored");
    symlinkSync(
      pathModule.join(rolesPath, "a.md"),
      pathModule.join(rolesPath, "link.md")
    );

    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.deepEqual(Object.keys(loaded.config.roles), ["a", "link", "z"]);
    }

    symlinkSync(
      pathModule.join(rolesPath, "missing.md"),
      pathModule.join(rolesPath, "broken.md")
    );
    const broken = loadChildRolesConfig(path);
    assert.equal(broken.ok, false);
    if (!broken.ok) {
      assert.equal(broken.path, pathModule.join(rolesPath, "broken.md"));
    }
    unlinkSync(pathModule.join(rolesPath, "broken.md"));

    writeFileSync(
      pathModule.join(rolesPath, "b.md"),
      "---\nunknown: true\n---\nPrompt"
    );
    writeFileSync(
      pathModule.join(rolesPath, "0.md"),
      "---\nunknown: true\n---\nPrompt"
    );
    const invalid = loadChildRolesConfig(path);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.path, pathModule.join(rolesPath, "0.md"));
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("rejects invalid role documents and identifies their source", () => {
  const cases: [string, RegExp][] = [
    ["   \n", /prompt/u],
    ["---\ndescription: nope\nPrompt", /Unterminated/u],
    ["---\n[broken\n---\nPrompt", /Flow sequence|YAML/u],
    [
      "---\ndescription: one\ndescription: two\n---\nPrompt",
      /Map keys must be unique/u,
    ],
    ["---\nmetadata\n---\nPrompt", /frontmatter must be an object/u],
    ["---\nunknown: true\n---\nPrompt", /not supported/u],
    ["---\ndescription: !custom value\n---\nPrompt", /tag|Tag/u],
    ["---\ndescription: '   '\n---\nPrompt", /non-whitespace/u],
    ["---\nmodel: []\n---\nPrompt", /non-empty array/u],
    ["---\nmodel: provider\n---\nPrompt", /exact provider\/model-id/u],
    ["---\nthinking: huge\n---\nPrompt", /must be one of/u],
  ];

  for (const [contents, expected] of cases) {
    const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
    const path = pathModule.join(directory, "herdr-subagents.json");
    const documentPath = pathModule.join(
      directory,
      "herdr-subagents",
      "roles",
      "explore.md"
    );
    try {
      mkdirSync(pathModule.join(directory, "herdr-subagents", "roles"), {
        recursive: true,
      });
      writeFileSync(documentPath, contents);
      const loaded = loadChildRolesConfig(path);
      assert.equal(loaded.ok, false);
      if (!loaded.ok) {
        assert.equal(loaded.path, documentPath);
        assert.match(loaded.error, expected);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

void test("loads and validates global child placement", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "herdr-subagents.json");
  try {
    for (const placement of ["tab", "split"] as const) {
      writeFileSync(path, JSON.stringify({ defaults: { placement } }));
      const loaded = loadChildRolesConfig(path);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        assert.equal(loaded.config.defaults.placement, placement);
      }
    }

    writeFileSync(path, JSON.stringify({ defaults: {} }));
    const omitted = loadChildRolesConfig(path);
    assert.equal(omitted.ok, true);
    if (omitted.ok) {
      assert.equal(omitted.config.defaults.placement, undefined);
    }

    for (const placement of ["pane", true, null]) {
      writeFileSync(path, JSON.stringify({ defaults: { placement } }));
      assert.match(
        errorOf(loadChildRolesConfig(path)),
        /defaults\.placement must be tab or split/u
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("rejects placement in role frontmatter", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "herdr-subagents.json");
  const documentPath = pathModule.join(
    directory,
    "herdr-subagents",
    "roles",
    "explore.md"
  );
  try {
    mkdirSync(pathModule.join(directory, "herdr-subagents", "roles"), {
      recursive: true,
    });
    writeFileSync(documentPath, "---\nplacement: split\n---\nExplore.");
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.equal(loaded.path, documentPath);
      assert.match(loaded.error, /frontmatter\.placement is not supported/u);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("validates global config and reports the JSON roles migration", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "herdr-subagents.json");
  try {
    for (const model of [
      [],
      [""],
      [42],
      [" provider/model"],
      ["provider/model "],
      ["provider"],
      ["/model"],
    ]) {
      writeFileSync(path, JSON.stringify({ defaults: { model } }));
      assert.match(
        errorOf(loadChildRolesConfig(path)),
        /exact provider\/model-id|non-empty array/u
      );
    }
    for (const orchestrator of [
      true,
      {},
      { enabled: "yes" },
      { enabled: true, prompt: "no" },
    ]) {
      writeFileSync(path, JSON.stringify({ orchestrator }));
      assert.match(errorOf(loadChildRolesConfig(path)), /orchestrator/u);
    }
    writeFileSync(
      path,
      JSON.stringify({ roles: { explore: { prompt: "Explore." } } })
    );
    assert.match(
      errorOf(loadChildRolesConfig(path)),
      /config\.roles is no longer supported.*herdr-subagents\/roles\/<name>\.md/u
    );
    writeFileSync(path, JSON.stringify({ defaults: { prompt: "no" } }));
    assert.match(errorOf(loadChildRolesConfig(path)), /not supported/u);
    writeFileSync(path, "{");
    const malformed = loadChildRolesConfig(path);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.path, path);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("rejects a whitespace-only filename-derived role name", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "herdr-subagents.json");
  const documentPath = pathModule.join(
    directory,
    "herdr-subagents",
    "roles",
    "   .md"
  );
  try {
    mkdirSync(pathModule.join(directory, "herdr-subagents", "roles"), {
      recursive: true,
    });
    writeFileSync(documentPath, "Prompt");
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.equal(loaded.path, documentPath);
      assert.match(loaded.error, /role names/u);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("reports an unreadable catalogue path", () => {
  const directory = mkdtempSync(pathModule.join(tmpdir(), "child-roles-"));
  const path = pathModule.join(directory, "herdr-subagents.json");
  const rolesPath = pathModule.join(directory, "herdr-subagents", "roles");
  try {
    mkdirSync(pathModule.join(directory, "herdr-subagents"));
    writeFileSync(rolesPath, "not a directory");
    const loaded = loadChildRolesConfig(path);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.equal(loaded.path, rolesPath);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("loads the shipped global config and role examples", () => {
  const path = pathModule.join(process.cwd(), "herdr-subagents.example.json");
  const loaded = loadChildRolesConfig(path);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.deepEqual(Object.keys(loaded.config.roles), [
      "explore",
      "reviewer",
      "worker",
    ]);
  }
});

void test("rejects inherited object properties as unknown roles", () => {
  for (const role of [
    "toString",
    "constructor",
    "hasOwnProperty",
    "__proto__",
  ]) {
    const resolution = resolve({ prompt: "inspect", role });
    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.equal(resolution.code, "role_not_found");
    }
  }
});

void test("resolves model and thinking independently with source metadata", () => {
  const routed = resolve({
    model: "explicit/nested/model",
    prompt: "inspect",
    role: "explore",
  });
  assert.deepEqual(routed, {
    ok: true,
    selection: {
      model: { id: "nested/model", provider: "explicit" },
      modelSource: "explicit",
      rolePrompt: "Explore the repository.",
      thinkingLevel: "low",
      thinkingSource: "role",
    },
  });

  const defaults = resolve({ prompt: "inspect" });
  assert.equal(defaults.ok, true);
  if (defaults.ok) {
    assert.equal(defaults.selection.modelSource, "default");
    assert.equal(defaults.selection.thinkingSource, "default");
  }
});

void test("uses the first available candidate from the highest-precedence model layer", () => {
  const routed = resolveChildRuntime({
    parent,
    routing: {
      availableModels: [
        { id: "model", provider: "default" },
        { id: "a/b", provider: "role" },
      ],
      config: {
        defaults: { model: ["default/missing", "default/model"] },
        roles: {
          explore: { model: ["role/missing", "role/a/b"], prompt: "Explore." },
        },
      },
    },
    task: { prompt: "inspect", role: "explore" },
  });
  assert.deepEqual(routed, {
    ok: true,
    selection: {
      model: { id: "a/b", provider: "role" },
      modelSource: "role",
      rolePrompt: "Explore.",
      thinkingLevel: "high",
      thinkingSource: "parent",
    },
  });

  const defaultRouted = resolveChildRuntime({
    parent,
    routing: {
      availableModels: [{ id: "model", provider: "default" }],
      config: {
        defaults: { model: ["default/missing", "default/model"] },
        roles: {},
      },
    },
    task: { prompt: "inspect" },
  });
  assert.equal(defaultRouted.ok, true);
  if (defaultRouted.ok) {
    assert.deepEqual(defaultRouted.selection.model, {
      id: "model",
      provider: "default",
    });
  }
});

void test("does not validate inherited Parent models or fall through unavailable chosen layers", () => {
  const inherited = resolveChildRuntime({
    parent,
    routing: { availableModels: [], config: { defaults: {}, roles: {} } },
    task: { prompt: "inspect" },
  });
  assert.equal(inherited.ok, true);
  if (inherited.ok) {
    assert.equal(inherited.selection.modelSource, "parent");
  }

  const unavailableDefault = resolveChildRuntime({
    parent,
    routing: {
      availableModels: [{ id: "unavailable", provider: "parent" }],
      config: {
        defaults: { model: ["default/missing", "default/also-missing"] },
        roles: {},
      },
    },
    task: { prompt: "inspect" },
  });
  assert.deepEqual(unavailableDefault, {
    code: "model_routing_failed",
    message: "The configured default Child model is not available",
    ok: false,
    selection: { thinkingLevel: "high", thinkingSource: "parent" },
  });
  assert.doesNotMatch(
    JSON.stringify(unavailableDefault),
    /default\/(?<model>missing|also-missing)/u
  );

  const unavailable = resolve({
    model: "missing/model",
    prompt: "inspect",
    role: "explore",
  });
  assert.deepEqual(unavailable, {
    code: "model_routing_failed",
    message: "Requested Child model missing/model is not available",
    ok: false,
    selection: { thinkingLevel: "low", thinkingSource: "role" },
  });
});

void test("keeps role prompts and model mappings out of guidance and routing errors", () => {
  const unknown = resolve({ prompt: "inspect", role: "missing" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.code, "role_not_found");
  }

  const unavailableRoleModel = resolveChildRuntime({
    parent,
    routing: {
      availableModels: [],
      config: {
        defaults: {},
        roles: {
          explore: {
            model: ["private/first", "private/model"],
            prompt: "Explore the repository.",
            thinking: "low",
          },
        },
      },
    },
    task: { prompt: "inspect", role: "explore" },
  });
  assert.deepEqual(unavailableRoleModel, {
    code: "model_routing_failed",
    message:
      "The model configured for the requested Child role is not available",
    ok: false,
    selection: { thinkingLevel: "low", thinkingSource: "role" },
  });
  assert.doesNotMatch(
    JSON.stringify(unavailableRoleModel),
    /private\/(?<model>first|model)/u
  );

  const guidance = roleGuidance(config);
  if (guidance === undefined || guidance === "") {
    throw new Error("Expected guidance for the configured role");
  }
  assert.match(guidance, /explore/u);
  assert.match(guidance, /Read-only exploration/u);
  assert.doesNotMatch(guidance, /Explore the repository|role\/model/u);
});
