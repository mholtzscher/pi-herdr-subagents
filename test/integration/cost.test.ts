import assert from "node:assert/strict";
import test from "node:test";

import { lookupHerdrChildStatus } from "../../src/cost.js";
import type { ChildResult } from "../../src/domain.js";
import type { HerdrJsonObject } from "../../src/herdr/protocol.js";
import { createFakeHerdrServer } from "../support/fake-herdr-server.js";

const child = (overrides: Partial<ChildResult> = {}): ChildResult => ({
  location: { paneId: "pane-1", tabId: "tab-1", workspaceId: "workspace-1" },
  paneClosed: false,
  requestIndex: 0,
  sessionId: "child-session",
  status: "succeeded",
  taskId: "task-1",
  truncated: false,
  ...overrides,
});

let responseFor: () => HerdrJsonObject = () => ({});

const withSocket = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env.HERDR_SOCKET_PATH;
  const server = await createFakeHerdrServer((request) => {
    if (request.method !== "agent.get") {
      throw new Error("unexpected method");
    }
    return responseFor();
  });
  process.env.HERDR_SOCKET_PATH = server.path;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_SOCKET_PATH;
    } else {
      process.env.HERDR_SOCKET_PATH = previous;
    }
    await server.close();
  }
};

const agentResponse = (
  status: string,
  session?: { kind: "id" | "path"; value: string },
  location?: { pane_id: string; tab_id: string; workspace_id: string }
) => ({
  agent: {
    agent_session: session ?? { kind: "id", value: "child-session" },
    agent_status: status,
    ...(location ?? {
      pane_id: "pane-1",
      tab_id: "tab-1",
      workspace_id: "workspace-1",
    }),
  },
});

responseFor = () => agentResponse("idle");

void test("validates Herdr identity and maps working, blocked, and idle states", async () => {
  await withSocket(async () => {
    responseFor = () => agentResponse("working");
    assert.equal(await lookupHerdrChildStatus(child()), "running");

    responseFor = () => agentResponse("blocked");
    assert.equal(await lookupHerdrChildStatus(child()), "blocked");

    responseFor = () => agentResponse("idle");
    assert.equal(await lookupHerdrChildStatus(child()), "open");
  });
});

void test("rejects unknown, malformed, mismatched, and unavailable Herdr responses", async () => {
  await withSocket(async () => {
    responseFor = () => agentResponse("paused");
    assert.equal(await lookupHerdrChildStatus(child()), undefined);

    responseFor = () => ({ agent: { agent_status: "idle" } });
    assert.equal(await lookupHerdrChildStatus(child()), undefined);

    responseFor = () => agentResponse("idle", { kind: "id", value: "other" });
    assert.equal(await lookupHerdrChildStatus(child()), undefined);

    responseFor = () =>
      agentResponse("idle", undefined, {
        pane_id: "other-pane",
        tab_id: "tab-1",
        workspace_id: "workspace-1",
      });
    assert.equal(await lookupHerdrChildStatus(child()), undefined);

    responseFor = () => agentResponse("idle");
    assert.equal(
      await lookupHerdrChildStatus(
        child({
          location: undefined,
          sessionId: undefined,
          sessionPath: undefined,
        })
      ),
      undefined
    );
  });
});

void test("matches path identities after resolution", async () => {
  await withSocket(async () => {
    responseFor = () =>
      agentResponse("idle", {
        kind: "path",
        value: "/tmp/child-session.jsonl",
      });
    assert.equal(
      await lookupHerdrChildStatus(
        child({ sessionId: undefined, sessionPath: "/tmp/child-session.jsonl" })
      ),
      "open"
    );
  });
});
