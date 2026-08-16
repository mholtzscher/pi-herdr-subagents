import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";

// oxlint-disable eslint/max-classes-per-file, promise/avoid-new

// `execFile` returns a ChildProcess even though `promisify` only consumes its callback.
// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);

export type HerdrJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly HerdrJsonValue[]
  | HerdrJsonObject;

export interface HerdrJsonObject {
  readonly [key: string]: HerdrJsonValue | undefined;
}

export type HerdrRequestParameters = HerdrJsonObject;

const HerdrJsonObjectSchema = Type.Object({}, { additionalProperties: true });
const HerdrRequestSchema = Type.Object({
  id: Type.String(),
  method: Type.String(),
  params: HerdrJsonObjectSchema,
});

export type HerdrRequest = Static<typeof HerdrRequestSchema>;

const HerdrErrorSchema = Type.Object(
  { code: Type.Optional(Type.String()), message: Type.Optional(Type.String()) },
  { additionalProperties: true }
);
const HerdrResponseSchema = Type.Object(
  {
    error: Type.Optional(HerdrErrorSchema),
    id: Type.String(),
    result: Type.Optional(HerdrJsonObjectSchema),
  },
  { additionalProperties: true }
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
                            method: Type.Optional(
                              Type.Object({
                                const: Type.Optional(Type.String()),
                              })
                            ),
                          },
                          { additionalProperties: true }
                        )
                      ),
                    },
                    { additionalProperties: true }
                  )
                )
              ),
            })
          ),
        },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);

type HerdrResponse = Static<typeof HerdrResponseSchema>;
type CapabilityDocument = Static<typeof CapabilitySchema>;

export class HerdrProtocolError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrProtocolError";
    this.code = code;
  }
}

const parseHerdrResponse = (raw: string): HerdrResponse => {
  const response: unknown = JSON.parse(raw);
  if (!Check(HerdrResponseSchema, response)) {
    throw new Error("Herdr response has an invalid shape");
  }
  return response;
};

export const parseHerdrRequest = (raw: string): HerdrRequest => {
  const request: unknown = JSON.parse(raw);
  if (!Check(HerdrRequestSchema, request)) {
    throw new HerdrProtocolError(
      "invalid_request",
      "Herdr request is not valid JSON-RPC"
    );
  }
  return request;
};

export class HerdrSocketClient {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  call<T extends HerdrJsonObject = HerdrJsonObject>(
    method: string,
    params: HerdrRequestParameters,
    signal?: AbortSignal
  ): Promise<T>;

  async call(
    method: string,
    params: HerdrRequestParameters,
    signal?: AbortSignal
  ): Promise<object> {
    if (signal?.aborted === true) {
      throw new HerdrProtocolError("aborted", "Herdr request aborted");
    }
    return await new Promise<object>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      const requestId = crypto.randomUUID();
      const abort = (): void => {
        socket.destroy(
          new HerdrProtocolError("aborted", "Herdr request aborted")
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (fn: () => void): void => {
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        fn();
      };
      socket.once("error", (error) => {
        finish(() => {
          reject(new HerdrProtocolError("socket_error", error.message));
        });
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) {
          return;
        }
        let response: HerdrResponse;
        try {
          response = parseHerdrResponse(buffer.slice(0, lineEnd));
        } catch {
          finish(() => {
            reject(
              new HerdrProtocolError(
                "invalid_response",
                "Herdr returned invalid JSON"
              )
            );
          });
          return;
        }
        if (response.id !== requestId) {
          return;
        }
        const { error } = response;
        if (error) {
          finish(() => {
            reject(
              new HerdrProtocolError(
                error.code ?? "server_error",
                error.message ?? "Herdr request failed"
              )
            );
          });
          return;
        }
        if (response.result === undefined) {
          finish(() => {
            reject(
              new HerdrProtocolError(
                "invalid_response",
                "Herdr response has no result"
              )
            );
          });
          return;
        }
        const { result } = response;
        finish(() => {
          resolve(result);
        });
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      });
    });
  }
}

export interface HerdrCapabilities {
  methods: Set<string>;
}

export const inspectCapabilities = async (
  signal?: AbortSignal
): Promise<HerdrCapabilities> => {
  const { stdout } = await execFileAsync("herdr", ["api", "schema", "--json"], {
    maxBuffer: 1024 * 1024,
    signal,
  });
  let schema: CapabilityDocument;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Check(CapabilitySchema, parsed)) {
      throw new Error("Herdr schema has an invalid shape");
    }
    schema = parsed;
  } catch {
    throw new HerdrProtocolError(
      "invalid_schema",
      "Herdr schema was not valid JSON"
    );
  }
  const methods = new Set<string>();
  const entries = schema.schemas?.request?.oneOf;
  if (!entries) {
    return { methods };
  }
  for (const entry of entries) {
    const method = entry.properties?.method?.const;
    if (method !== undefined) {
      methods.add(method);
    }
  }
  return { methods };
};

export const assertSocketReachable = async (
  socketPath: string,
  signal?: AbortSignal
): Promise<void> => {
  const client = new HerdrSocketClient(socketPath);
  await client.call(
    "agent.get",
    { target: process.env.HERDR_PANE_ID ?? "" },
    signal
  );
};
