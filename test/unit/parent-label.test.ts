import assert from "node:assert/strict";
import test from "node:test";

import {
  findParentLabel,
  loadOrCreateParentLabel,
  PARENT_LABEL_ENTRY,
} from "../../src/parent-label.js";

void test("reuses the latest stored internal Parent label", () => {
  const entries = [
    {
      customType: PARENT_LABEL_ENTRY,
      data: { label: "first-parent" },
      type: "custom",
    },
    {
      customType: "other-extension",
      data: { label: "ignored" },
      type: "custom",
    },
    {
      customType: PARENT_LABEL_ENTRY,
      data: { label: "latest-parent" },
      type: "custom",
    },
  ];
  let persisted = false;

  const label = loadOrCreateParentLabel(
    entries,
    () => {
      persisted = true;
    },
    () => "generated-parent"
  );

  assert.equal(findParentLabel(entries), "latest-parent");
  assert.equal(label, "latest-parent");
  assert.equal(persisted, false);
});

void test("persists a generated Parent label when none exists", () => {
  let persisted: string | undefined;

  const label = loadOrCreateParentLabel(
    [],
    (value) => {
      persisted = value;
    },
    () => "calm-otter"
  );

  assert.equal(label, "calm-otter");
  assert.equal(persisted, "calm-otter");
});
