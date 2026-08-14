import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseHerdrRequest, type HerdrJsonObject, type HerdrRequest } from "../../src/herdr/protocol.js";

const CodedErrorSchema = Type.Object({ code: Type.String() }, { additionalProperties: true });

export async function createFakeHerdrServer(
  handler: (request: HerdrRequest) => HerdrJsonObject,
): Promise<{ path: string; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-protocol-"));
  const path = join(dir, "herdr.sock");
  const server: Server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      const lineEnd = data.indexOf("\n");
      if (lineEnd < 0) return;
      const request = parseHerdrRequest(data.slice(0, lineEnd));
      try {
        socket.end(`${JSON.stringify({ id: request.id, result: handler(request) })}\n`);
      } catch (cause) {
        const code = Check(CodedErrorSchema, cause) ? cause.code : "fake_error";
        socket.end(
          `${JSON.stringify({ id: request.id, error: { code, message: cause instanceof Error ? cause.message : String(cause) } })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true });
    },
  };
}
