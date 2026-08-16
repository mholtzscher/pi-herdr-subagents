import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { Check } from "typebox/value";

import { parseHerdrRequest } from "../../src/herdr/protocol.js";
import type {
  HerdrJsonObject,
  HerdrRequest,
} from "../../src/herdr/protocol.js";

const CodedErrorSchema = Type.Object(
  { code: Type.String() },
  { additionalProperties: true }
);

export const createFakeHerdrServer = async (
  handler: (request: HerdrRequest) => HerdrJsonObject
): Promise<{ path: string; close: () => Promise<void> }> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-herdr-protocol-"));
  const socketPath = path.join(dir, "herdr.sock");
  const server: Server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const lineEnd = data.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const request = parseHerdrRequest(data.slice(0, lineEnd));
      try {
        socket.end(
          `${JSON.stringify({ id: request.id, result: handler(request) })}\n`
        );
      } catch (error) {
        const code = Check(CodedErrorSchema, error) ? error.code : "fake_error";
        socket.end(
          `${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) }, id: request.id })}\n`
        );
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    async close() {
      server.close();
      await once(server, "close");
      await rm(dir, { recursive: true });
    },
    path: socketPath,
  };
};
