import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import type {
  ChildLocation,
  ChildPlacement,
  ParentContext,
  TaskId,
} from "../domain.js";
import {
  assertSocketReachable,
  HerdrProtocolError,
  HerdrSocketClient,
  inspectCapabilities,
} from "./protocol.js";
import type { HerdrJsonObject, HerdrRequestParameters } from "./protocol.js";

// oxlint-disable eslint/max-classes-per-file, eslint/class-methods-use-this, eslint/no-await-in-loop, promise/avoid-new

export interface HostInspection {
  workspaceId: string;
  tabId: string;
  paneId: string;
  socketPath: string;
}

export interface StartChildRequest {
  taskId: TaskId;
  placement: ChildPlacement;
  sessionId: string;
  context: ParentContext;
  rolePrompt?: string;
  parent: HostInspection;
}

export interface HostedChild {
  taskId: TaskId;
  sessionId: string;
  sessionPath?: string;
  baselineEntryId?: string;
  location: ChildLocation;
  agentName: string;
  terminalId?: string;
}

export interface ChildSettlement {
  status: "settled" | "blocked";
}

/** A startup error may still identify a pane that the caller can inspect. */
export class StartChildError extends Error {
  public readonly child?: HostedChild;

  constructor(message: string, child?: HostedChild) {
    super(message);
    this.name = "StartChildError";
    this.child = child;
  }
}

export interface ChildHost {
  inspect: (signal?: AbortSignal) => Promise<HostInspection>;
  renameParent: (
    parent: HostInspection,
    context: ParentContext,
    signal?: AbortSignal
  ) => Promise<void>;
  start: (
    request: StartChildRequest,
    signal?: AbortSignal
  ) => Promise<HostedChild>;
  prompt: (
    child: HostedChild,
    prompt: string,
    signal?: AbortSignal
  ) => Promise<ChildSettlement>;
  close: (child: HostedChild, signal?: AbortSignal) => Promise<void>;
}

/** Current-parent-session state only; it is intentionally never persisted. */
export class SessionChildRegistry {
  private readonly children = new Map<string, HostedChild>();

  add(child: HostedChild): void {
    this.children.set(child.location.paneId, child);
  }

  remove(child: HostedChild): void {
    this.children.delete(child.location.paneId);
  }

  async closeAll(host: ChildHost): Promise<void> {
    await Promise.all(
      Array.from(this.children.values(), async (child) => {
        try {
          await host.close(child);
        } catch {
          // Ownership/occupant verification failed. Never close an uncertain pane.
        }
      })
    );
    this.children.clear();
  }
}

const REQUIRED_METHODS = [
  "tab.create",
  "tab.rename",
  "pane.split",
  "pane.rename",
  "pane.process_info",
  "agent.start",
  "agent.prompt",
  "agent.get",
  "pane.close",
];
const SHELL_READY_RETRY_CODES = new Set([
  "agent_pane_not_found",
  "agent_pane_unavailable",
  "agent_pane_busy",
]);
const SHELL_READY_ATTEMPTS = 240;
const SHELL_STABLE_POLLS = 3;

const PaneProcessInfoSchema = Type.Object(
  {
    process_info: Type.Optional(
      Type.Object(
        {
          foreground_processes: Type.Optional(
            Type.Array(
              Type.Object(
                { pid: Type.Optional(Type.Number()) },
                { additionalProperties: true }
              )
            )
          ),
          shell_pid: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);
const AgentSessionSchema = Type.Object(
  { kind: Type.Optional(Type.String()), value: Type.Optional(Type.String()) },
  { additionalProperties: true }
);
const AgentInfoResponseSchema = Type.Object(
  {
    agent: Type.Optional(
      Type.Object(
        {
          agent_session: Type.Optional(
            Type.Union([AgentSessionSchema, Type.Null()])
          ),
          agent_status: Type.Optional(Type.String()),
          pane_id: Type.Optional(Type.String()),
          tab_id: Type.Optional(Type.String()),
          terminal_id: Type.Optional(Type.String()),
          workspace_id: Type.Optional(Type.String()),
        },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);
const CreatedTabSchema = Type.Object(
  {
    root_pane: Type.Optional(
      Type.Object(
        { pane_id: Type.Optional(Type.String()) },
        { additionalProperties: true }
      )
    ),
    tab: Type.Optional(
      Type.Object(
        { tab_id: Type.Optional(Type.String()) },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);
const CreatedSplitSchema = Type.Object(
  {
    pane: Type.Optional(
      Type.Object(
        {
          pane_id: Type.Optional(Type.String()),
          tab_id: Type.Optional(Type.String()),
          workspace_id: Type.Optional(Type.String()),
        },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);
const PromptResultSchema = Type.Object(
  {
    agent: Type.Optional(
      Type.Object(
        { agent_status: Type.Optional(Type.String()) },
        { additionalProperties: true }
      )
    ),
    agent_status: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);
const SessionEntrySchema = Type.Object(
  { id: Type.Optional(Type.String()), type: Type.Optional(Type.String()) },
  { additionalProperties: true }
);

type PaneProcessInfo = Static<typeof PaneProcessInfoSchema>;
type AgentInfoResponse = Static<typeof AgentInfoResponseSchema>;
type CreatedTab = Static<typeof CreatedTabSchema>;
type CreatedSplit = Static<typeof CreatedSplitSchema>;
type PromptResult = Static<typeof PromptResultSchema>;
type SessionEntry = Static<typeof SessionEntrySchema>;

const writeRolePrompt = async (
  prompt: string
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-herdr-role-"));
  const filePath = path.join(dir, "prompt.md");
  await writeFile(filePath, `Child role instructions:\n${prompt}`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return { dir, path: filePath };
};

const labelSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "") || "parent";

const childLabel = (request: StartChildRequest): string => {
  const parent = request.context.parentLabel ?? request.parent.paneId;
  return `Pi [${labelSegment(parent)}] ${request.taskId}`;
};

const childName = (taskId: TaskId): string =>
  `pi_${taskId.replaceAll(/[^a-z0-9_]/gu, "_")}_${randomUUID().replaceAll("-", "").slice(0, 12)}`.slice(
    0,
    32
  );

const isNonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

const piArgs = (
  request: StartChildRequest,
  rolePromptPath?: string
): string[] => {
  const args = [
    "--session-id",
    request.sessionId,
    "--name",
    childLabel(request),
    "--entire-nested",
    "--exclude-tools",
    "spawn_pi",
  ];
  if (request.context.model) {
    args.push(
      "--model",
      `${request.context.model.provider}/${request.context.model.id}`
    );
  }
  if (request.context.thinkingLevel) {
    args.push("--thinking", request.context.thinkingLevel);
  }
  if (isNonEmpty(rolePromptPath)) {
    args.push("--append-system-prompt", rolePromptPath);
  }
  return args;
};

const delay = async (
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> => {
  if (signal?.aborted === true) {
    throw new HerdrProtocolError("aborted", "Herdr startup wait aborted");
  }
  await new Promise<void>((resolve, reject) => {
    // oxlint-disable-next-line eslint/prefer-const
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(new HerdrProtocolError("aborted", "Herdr startup wait aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
};

const socketPath = (): string => {
  const socket = process.env.HERDR_SOCKET_PATH;
  if (!isNonEmpty(socket)) {
    throw new HerdrProtocolError(
      "unavailable",
      "Herdr socket path is unavailable"
    );
  }
  return socket;
};

const latestSessionEntryId = async (
  sessionPath: string
): Promise<string | undefined> => {
  try {
    const sessionContents = await readFile(sessionPath, "utf-8");
    const lines = sessionContents.trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed: unknown = JSON.parse(lines[index]);
      if (!Check(SessionEntrySchema, parsed)) {
        continue;
      }
      const entry: SessionEntry = parsed;
      if (entry.type !== "session" && entry.id !== undefined) {
        return entry.id;
      }
    }
  } catch {
    // A newly started Pi can report its session before the file exists; there is no baseline then.
  }
  return undefined;
};

const parsePaneProcessInfo = (payload: HerdrJsonObject): PaneProcessInfo => {
  if (!Check(PaneProcessInfoSchema, payload)) {
    throw new HerdrProtocolError(
      "invalid_response",
      "Herdr did not return pane process information"
    );
  }
  return payload;
};

const parseAgentInfo = (payload: HerdrJsonObject): AgentInfoResponse => {
  if (!Check(AgentInfoResponseSchema, payload)) {
    throw new HerdrProtocolError(
      "invalid_response",
      "Herdr did not return agent information"
    );
  }
  return payload;
};

const parseCreatedTab = (payload: HerdrJsonObject): CreatedTab => {
  if (!Check(CreatedTabSchema, payload)) {
    throw new HerdrProtocolError(
      "invalid_response",
      "Herdr did not return a child tab and pane"
    );
  }
  return payload;
};

const parseCreatedSplit = (payload: HerdrJsonObject): CreatedSplit => {
  if (!Check(CreatedSplitSchema, payload)) {
    throw new HerdrProtocolError(
      "invalid_response",
      "Herdr did not return a child split"
    );
  }
  return payload;
};

const parsePromptResult = (payload: HerdrJsonObject): PromptResult => {
  if (!Check(PromptResultSchema, payload)) {
    throw new HerdrProtocolError(
      "invalid_response",
      "Herdr did not return the child prompt status"
    );
  }
  return payload;
};

export class HerdrChildHost implements ChildHost {
  private readonly registry?: SessionChildRegistry;

  constructor(registry?: SessionChildRegistry) {
    this.registry = registry;
  }

  async inspect(signal?: AbortSignal): Promise<HostInspection> {
    if (process.env.HERDR_ENV !== "1") {
      throw new HerdrProtocolError(
        "unavailable",
        "spawn_pi requires a Herdr-managed Pi pane (HERDR_ENV=1)"
      );
    }
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    const tabId = process.env.HERDR_TAB_ID;
    const paneId = process.env.HERDR_PANE_ID;
    const envSocketPath = process.env.HERDR_SOCKET_PATH;
    if (
      !isNonEmpty(workspaceId) ||
      !isNonEmpty(tabId) ||
      !isNonEmpty(paneId) ||
      !isNonEmpty(envSocketPath)
    ) {
      throw new HerdrProtocolError(
        "unavailable",
        "Herdr caller identity or socket path is unavailable"
      );
    }
    const capabilities = await inspectCapabilities(signal);
    const missing = REQUIRED_METHODS.filter(
      (method) => !capabilities.methods.has(method)
    );
    if (missing.length) {
      throw new HerdrProtocolError(
        "unsupported",
        `Herdr does not support: ${missing.join(", ")}`
      );
    }
    await assertSocketReachable(envSocketPath, signal);
    const parentResponse = await new HerdrSocketClient(envSocketPath).call(
      "agent.get",
      { target: paneId },
      signal
    );
    const parent = parseAgentInfo(parentResponse);
    const { agent } = parent;
    if (
      !agent ||
      agent.workspace_id !== workspaceId ||
      agent.tab_id !== tabId ||
      agent.pane_id !== paneId
    ) {
      throw new HerdrProtocolError(
        "caller_identity_mismatch",
        "Herdr did not confirm the Parent pane identity"
      );
    }
    return { paneId, socketPath: envSocketPath, tabId, workspaceId };
  }

  async renameParent(
    parent: HostInspection,
    context: ParentContext,
    signal?: AbortSignal
  ): Promise<void> {
    const label = `Pi [${labelSegment(context.parentLabel ?? parent.paneId)}]`;
    await new HerdrSocketClient(parent.socketPath).call(
      "tab.rename",
      { label, tab_id: parent.tabId },
      signal
    );
  }

  async start(
    request: StartChildRequest,
    signal?: AbortSignal
  ): Promise<HostedChild> {
    const client = new HerdrSocketClient(request.parent.socketPath);
    let location: ChildLocation | undefined;
    let rolePromptFile: { dir: string; path: string } | undefined;
    const agentName = childName(request.taskId);
    try {
      location = await this.createLocation(client, request, signal);
      await client.call(
        "pane.rename",
        { label: childLabel(request), pane_id: location.paneId },
        signal
      );
      rolePromptFile = isNonEmpty(request.rolePrompt)
        ? await writeRolePrompt(request.rolePrompt)
        : undefined;
      await this.startWhenShellStable(
        client,
        location.paneId,
        {
          args: piArgs(request, rolePromptFile?.path),
          kind: "pi",
          name: agentName,
          pane_id: location.paneId,
          timeout_ms: 30_000,
        },
        signal
      );
      const info = await this.waitForSession(client, location.paneId, signal);
      const child = await this.hostedChild(request, location, agentName, info);
      this.registry?.add(child);
      return child;
    } catch (error) {
      const child = location
        ? await this.partialChild(request, location, agentName)
        : undefined;
      if (isNonEmpty(child?.terminalId)) {
        this.registry?.add(child);
      }
      throw new StartChildError(
        error instanceof Error ? error.message : String(error),
        child
      );
    } finally {
      if (rolePromptFile) {
        await rm(rolePromptFile.dir, { force: true, recursive: true }).catch(
          () => null
        );
      }
    }
  }

  async prompt(
    child: HostedChild,
    prompt: string,
    signal?: AbortSignal
  ): Promise<ChildSettlement> {
    const client = new HerdrSocketClient(socketPath());
    const result = await this.promptWhenRecognized(
      client,
      child.location.paneId,
      prompt,
      signal
    );
    let status = result.agent?.agent_status ?? result.agent_status;
    if (status === undefined) {
      const agentInfo = await this.getAgent(
        client,
        child.location.paneId,
        signal
      );
      status = agentInfo.agent?.agent_status;
    }
    return { status: status === "blocked" ? "blocked" : "settled" };
  }

  async close(child: HostedChild, signal?: AbortSignal): Promise<void> {
    const client = new HerdrSocketClient(socketPath());
    const info = await this.getAgent(client, child.location.paneId, signal);
    const current = info.agent;
    if (
      !current ||
      current.pane_id !== child.location.paneId ||
      current.terminal_id !== child.terminalId
    ) {
      throw new HerdrProtocolError(
        "occupant_changed",
        "Child pane is no longer occupied by the expected Pi"
      );
    }
    await client.call("pane.close", { pane_id: child.location.paneId }, signal);
    this.registry?.remove(child);
  }

  private async createLocation(
    client: HerdrSocketClient,
    request: StartChildRequest,
    signal?: AbortSignal
  ): Promise<ChildLocation> {
    if (request.placement === "tab") {
      const result = parseCreatedTab(
        await client.call(
          "tab.create",
          {
            cwd: request.context.cwd,
            focus: false,
            label: childLabel(request),
            workspace_id: request.parent.workspaceId,
          },
          signal
        )
      );
      const tabId = result.tab?.tab_id;
      const paneId = result.root_pane?.pane_id;
      if (!isNonEmpty(tabId) || !isNonEmpty(paneId)) {
        throw new HerdrProtocolError(
          "invalid_response",
          "Herdr did not return a child tab and pane"
        );
      }
      return { paneId, tabId, workspaceId: request.parent.workspaceId };
    }
    const result = parseCreatedSplit(
      await client.call(
        "pane.split",
        {
          cwd: request.context.cwd,
          direction: "right",
          focus: false,
          target_pane_id: request.parent.paneId,
          workspace_id: request.parent.workspaceId,
        },
        signal
      )
    );
    const { pane } = result;
    if (
      !isNonEmpty(pane?.workspace_id) ||
      !isNonEmpty(pane?.tab_id) ||
      !isNonEmpty(pane?.pane_id)
    ) {
      throw new HerdrProtocolError(
        "invalid_response",
        "Herdr did not return a child split"
      );
    }
    return {
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      workspaceId: pane.workspace_id,
    };
  }

  private async hostedChild(
    request: StartChildRequest,
    location: ChildLocation,
    agentName: string,
    info: AgentInfoResponse
  ): Promise<HostedChild> {
    const sessionPath = info.agent?.agent_session?.value;
    return {
      agentName,
      baselineEntryId: isNonEmpty(sessionPath)
        ? await latestSessionEntryId(sessionPath)
        : undefined,
      location,
      sessionId: request.sessionId,
      sessionPath,
      taskId: request.taskId,
      terminalId: info.agent?.terminal_id,
    };
  }

  private async partialChild(
    request: StartChildRequest,
    location: ChildLocation,
    agentName: string
  ): Promise<HostedChild> {
    try {
      return await this.hostedChild(
        request,
        location,
        agentName,
        await this.getAgent(
          new HerdrSocketClient(request.parent.socketPath),
          location.paneId
        )
      );
    } catch {
      return {
        agentName,
        location,
        sessionId: request.sessionId,
        taskId: request.taskId,
      };
    }
  }

  private async getAgent(
    client: HerdrSocketClient,
    target: string,
    signal?: AbortSignal
  ): Promise<AgentInfoResponse> {
    return parseAgentInfo(await client.call("agent.get", { target }, signal));
  }

  private async startWhenShellStable(
    client: HerdrSocketClient,
    paneId: string,
    params: HerdrRequestParameters,
    signal?: AbortSignal
  ): Promise<void> {
    let stablePolls = 0;
    for (let attempt = 0; attempt < SHELL_READY_ATTEMPTS; attempt += 1) {
      let processInfo: PaneProcessInfo["process_info"];
      try {
        ({ process_info: processInfo } = parsePaneProcessInfo(
          await client.call("pane.process_info", { pane_id: paneId }, signal)
        ));
      } catch (error) {
        if (
          !(error instanceof HerdrProtocolError) ||
          error.code !== "pane_not_found"
        ) {
          throw error;
        }
      }
      const foreground = processInfo?.foreground_processes;
      const shellIsStable =
        processInfo?.shell_pid !== null &&
        processInfo?.shell_pid !== undefined &&
        foreground?.length === 1 &&
        foreground[0]?.pid === processInfo.shell_pid;
      stablePolls = shellIsStable ? stablePolls + 1 : 0;
      if (stablePolls >= SHELL_STABLE_POLLS) {
        try {
          await client.call("agent.start", params, signal);
          return;
        } catch (error) {
          if (
            !(error instanceof HerdrProtocolError) ||
            !SHELL_READY_RETRY_CODES.has(error.code) ||
            attempt === SHELL_READY_ATTEMPTS - 1
          ) {
            throw error;
          }
          stablePolls = 0;
        }
      }
      await delay(250, signal);
    }
    throw new HerdrProtocolError(
      "start_timeout",
      "Herdr did not report a stable child shell"
    );
  }

  private async waitForSession(
    client: HerdrSocketClient,
    paneId: string,
    signal?: AbortSignal
  ): Promise<AgentInfoResponse> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const info = await this.getAgent(client, paneId, signal);
      if (
        info.agent?.agent_session?.kind === "path" &&
        isNonEmpty(info.agent.agent_session.value)
      ) {
        return info;
      }
      await delay(250, signal);
    }
    throw new HerdrProtocolError(
      "start_timeout",
      "Herdr did not report the child Pi session path"
    );
  }

  private async promptWhenRecognized(
    client: HerdrSocketClient,
    paneId: string,
    prompt: string,
    signal?: AbortSignal
  ): Promise<PromptResult> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        return parsePromptResult(
          await client.call(
            "agent.prompt",
            { target: paneId, text: prompt, wait: {} },
            signal
          )
        );
      } catch (error) {
        if (
          !(error instanceof HerdrProtocolError) ||
          !error.message.includes("not an active named agent") ||
          attempt === 59
        ) {
          throw error;
        }
        await delay(500, signal);
      }
    }
    throw new HerdrProtocolError(
      "start_timeout",
      "Herdr did not recognize the child Pi"
    );
  }
}
