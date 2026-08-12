import assert from "node:assert/strict";
import test from "node:test";
import { HerdrSocketClient } from "../../src/herdr/protocol.js";
import { createFakeHerdrServer } from "../support/fake-herdr-server.js";

test("uses one LF-delimited JSON request per socket connection", async () => {
  let requests = 0;
  const server = await createFakeHerdrServer((request) => {
    requests += 1;
    return { method: request.method };
  });
  try {
    const response = await new HerdrSocketClient(server.path).call<{ method: string }>("agent.get", { target: "p1" });
    assert.deepEqual(response, { method: "agent.get" });
    assert.equal(requests, 1);
  } finally {
    await server.close();
  }
});
