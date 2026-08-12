import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class HerdrProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class HerdrSocketClient {
  constructor(private readonly socketPath: string) {}

  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new HerdrProtocolError("aborted", "Herdr request aborted");
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      const requestId = crypto.randomUUID();
      const abort = () => socket.destroy(new HerdrProtocolError("aborted", "Herdr request aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (fn: () => void) => {
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        fn();
      };
      socket.once("error", (error) => finish(() => reject(new HerdrProtocolError("socket_error", error.message))));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd < 0) return;
        let response: { id?: string; result?: T; error?: { code?: string; message?: string } };
        try {
          response = JSON.parse(buffer.slice(0, lineEnd));
        } catch {
          finish(() => reject(new HerdrProtocolError("invalid_response", "Herdr returned invalid JSON")));
          return;
        }
        if (response.id !== requestId) return;
        const error = response.error;
        if (error) {
          finish(() => reject(new HerdrProtocolError(error.code ?? "server_error", error.message ?? "Herdr request failed")));
          return;
        }
        finish(() => resolve(response.result as T));
      });
      socket.once("connect", () => socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`));
    });
  }
}

export interface HerdrCapabilities {
  methods: Set<string>;
}

export async function inspectCapabilities(signal?: AbortSignal): Promise<HerdrCapabilities> {
  const { stdout } = await execFileAsync("herdr", ["api", "schema", "--json"], { signal, maxBuffer: 1024 * 1024 });
  let schema: { schemas?: { request?: { oneOf?: Array<{ properties?: { method?: { const?: string } } }> } } };
  try {
    schema = JSON.parse(stdout) as typeof schema;
  } catch {
    throw new HerdrProtocolError("invalid_schema", "Herdr schema was not valid JSON");
  }
  const methods = new Set(
    schema.schemas?.request?.oneOf
      ?.map((entry) => entry.properties?.method?.const)
      .filter((method): method is string => typeof method === "string") ?? [],
  );
  return { methods };
}

export async function assertSocketReachable(socketPath: string, signal?: AbortSignal): Promise<void> {
  const client = new HerdrSocketClient(socketPath);
  await client.call("agent.get", { target: process.env.HERDR_PANE_ID ?? "" }, signal);
}
