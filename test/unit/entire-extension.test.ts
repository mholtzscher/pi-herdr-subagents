import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerEntire from "../../.pi/extensions/entire/index.js";

function registeredEvents(nested: boolean): string[] {
  const events: string[] = [];
  const registerFlag: ExtensionAPI["registerFlag"] = () => {};
  const getFlag: ExtensionAPI["getFlag"] = () => nested;
  const on: ExtensionAPI["on"] = (name) => {
    events.push(name);
  };
  // SAFETY: The extension factory only uses these four ExtensionAPI members during registration; handlers are captured, not invoked.
  const pi = { registerFlag, getFlag, on } as ExtensionAPI;
  registerEntire(pi);
  return events;
}

test("preserves top-level Entire lifecycle hooks across extension reloads", () => {
  const expected = ["tool_call", "input", "session_start", "before_agent_start", "agent_end", "session_shutdown"];
  assert.deepEqual(registeredEvents(false), expected);
  assert.deepEqual(registeredEvents(false), expected);
});

test("limits nested Pi processes to non-interactive bash hardening", () => {
  assert.deepEqual(registeredEvents(true), ["tool_call"]);
});
