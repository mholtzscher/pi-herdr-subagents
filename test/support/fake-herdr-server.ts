import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFakeHerdrServer(handler: (request: { id: string; method: string; params: unknown }) => unknown): Promise<{ path: string; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-protocol-"));
  const path = join(dir, "herdr.sock");
  const server: Server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      const lineEnd = data.indexOf("\n");
      if (lineEnd < 0) return;
      const request = JSON.parse(data.slice(0, lineEnd)) as { id: string; method: string; params: unknown };
      try {
        socket.end(`${JSON.stringify({ id: request.id, result: handler(request) })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ id: request.id, error: { code: "fake_error", message: error instanceof Error ? error.message : String(error) } })}\n`);
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
