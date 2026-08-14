import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const execFileAsync = promisify(execFile);

export type HerdrJsonValue = boolean | number | string | null | readonly HerdrJsonValue[] | HerdrJsonObject;

export interface HerdrJsonObject {
  readonly [key: string]: HerdrJsonValue | undefined;
}

export type HerdrRequestParameters = HerdrJsonObject;

export interface HerdrRequest {
  id: string;
  method: string;
  params: HerdrRequestParameters;
}

const HerdrJsonObjectSchema = Type.Object({}, { additionalProperties: true });
const HerdrRequestSchema = Type.Object({
  id: Type.String(),
  method: Type.String(),
  params: HerdrJsonObjectSchema,
});
const HerdrErrorSchema = Type.Object(
  { code: Type.Optional(Type.String()), message: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
const HerdrResponseSchema = Type.Object(
  {
    id: Type.String(),
    result: Type.Optional(HerdrJsonObjectSchema),
    error: Type.Optional(HerdrErrorSchema),
  },
  { additionalProperties: true },
);
const CapabilitySchema = Type.Object(
  {
    schemas: Type.Optional(
      Type.Object(
        {
          request: Type.Optional(
            Type.Object({
              oneOf: Type.Optional(
                Type.Array(
                  Type.Object(
                    {
                      properties: Type.Optional(
                        Type.Object(
                          {
                            method: Type.Optional(Type.Object({ const: Type.Optional(Type.String()) })),
                          },
                          { additionalProperties: true },
                        ),
                      ),
                    },
                    { additionalProperties: true },
                  ),
                ),
              ),
            }),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type HerdrResponse = Static<typeof HerdrResponseSchema>;
type CapabilityDocument = Static<typeof CapabilitySchema>;

export class HerdrProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseHerdrRequest(raw: string): HerdrRequest {
  const request: unknown = JSON.parse(raw);
  if (!Check(HerdrRequestSchema, request))
    throw new HerdrProtocolError("invalid_request", "Herdr request is not valid JSON-RPC");
  // SAFETY: JSON.parse produces JSON values, and the schema confirms this value has string id/method and object params.
  return request as HerdrRequest;
}

export class HerdrSocketClient {
  constructor(private readonly socketPath: string) {}

  async call<T extends HerdrJsonObject = HerdrJsonObject>(
    method: string,
    params: HerdrRequestParameters,
    signal?: AbortSignal,
  ): Promise<T> {
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
        let response: HerdrResponse;
        try {
          response = parseHerdrResponse(buffer.slice(0, lineEnd));
        } catch {
          finish(() => reject(new HerdrProtocolError("invalid_response", "Herdr returned invalid JSON")));
          return;
        }
        if (response.id !== requestId) return;
        const error = response.error;
        if (error) {
          finish(() =>
            reject(new HerdrProtocolError(error.code ?? "server_error", error.message ?? "Herdr request failed")),
          );
          return;
        }
        if (response.result === undefined) {
          finish(() => reject(new HerdrProtocolError("invalid_response", "Herdr response has no result")));
          return;
        }
        // SAFETY: The socket response validator confirms `result` is a JSON object; callers validate narrower contracts.
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
  let schema: CapabilityDocument;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Check(CapabilitySchema, parsed)) throw new Error("Herdr schema has an invalid shape");
    schema = parsed;
  } catch {
    throw new HerdrProtocolError("invalid_schema", "Herdr schema was not valid JSON");
  }
  const methods = new Set(
    schema.schemas?.request?.oneOf?.flatMap((entry) => {
      const method = entry.properties?.method?.const;
      return method === undefined ? [] : [method];
    }) ?? [],
  );
  return { methods };
}

export async function assertSocketReachable(socketPath: string, signal?: AbortSignal): Promise<void> {
  const client = new HerdrSocketClient(socketPath);
  await client.call("agent.get", { target: process.env.HERDR_PANE_ID ?? "" }, signal);
}

function parseHerdrResponse(raw: string): HerdrResponse {
  const response: unknown = JSON.parse(raw);
  if (!Check(HerdrResponseSchema, response)) throw new Error("Herdr response has an invalid shape");
  return response;
}
