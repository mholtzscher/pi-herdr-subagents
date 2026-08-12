import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ChildLocation, ChildPlacement, ParentContext, TaskId } from "../domain.js";
import { assertSocketReachable, HerdrProtocolError, HerdrSocketClient, inspectCapabilities } from "./protocol.js";

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
  constructor(message: string, readonly child?: HostedChild) {
    super(message);
  }
}

export interface ChildHost {
  inspect(signal?: AbortSignal): Promise<HostInspection>;
  renameParent(parent: HostInspection, context: ParentContext, signal?: AbortSignal): Promise<void>;
  start(request: StartChildRequest, signal?: AbortSignal): Promise<HostedChild>;
  prompt(child: HostedChild, prompt: string, signal?: AbortSignal): Promise<ChildSettlement>;
  close(child: HostedChild, signal?: AbortSignal): Promise<void>;
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
    await Promise.all(Array.from(this.children.values(), async (child) => {
      try {
        await host.close(child);
      } catch {
        // Ownership/occupant verification failed. Never close an uncertain pane.
      }
    }));
    this.children.clear();
  }
}

const REQUIRED_METHODS = ["tab.create", "tab.rename", "pane.split", "pane.rename", "agent.start", "agent.prompt", "agent.get", "pane.close"];

type AgentInfoResponse = {
  agent?: {
    terminal_id?: string;
    agent_status?: string;
    workspace_id?: string;
    tab_id?: string;
    pane_id?: string;
    agent_session?: { kind?: string; value?: string };
  };
};

export class HerdrChildHost implements ChildHost {
  constructor(private readonly registry?: SessionChildRegistry) {}

  async inspect(signal?: AbortSignal): Promise<HostInspection> {
    if (process.env.HERDR_ENV !== "1") throw new HerdrProtocolError("unavailable", "spawn_pi requires a Herdr-managed Pi pane (HERDR_ENV=1)");
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    const tabId = process.env.HERDR_TAB_ID;
    const paneId = process.env.HERDR_PANE_ID;
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!workspaceId || !tabId || !paneId || !socketPath) {
      throw new HerdrProtocolError("unavailable", "Herdr caller identity or socket path is unavailable");
    }
    const capabilities = await inspectCapabilities(signal);
    const missing = REQUIRED_METHODS.filter((method) => !capabilities.methods.has(method));
    if (missing.length) throw new HerdrProtocolError("unsupported", `Herdr does not support: ${missing.join(", ")}`);
    await assertSocketReachable(socketPath, signal);
    const parent = await new HerdrSocketClient(socketPath).call<AgentInfoResponse>("agent.get", { target: paneId }, signal);
    const agent = parent.agent;
    if (!agent || agent.workspace_id !== workspaceId || agent.tab_id !== tabId || agent.pane_id !== paneId) {
      throw new HerdrProtocolError("caller_identity_mismatch", "Herdr did not confirm the Parent pane identity");
    }
    return { workspaceId, tabId, paneId, socketPath };
  }

  async renameParent(parent: HostInspection, context: ParentContext, signal?: AbortSignal): Promise<void> {
    const label = `Pi [${labelSegment(context.parentLabel ?? parent.paneId)}]`;
    await new HerdrSocketClient(parent.socketPath).call("tab.rename", { tab_id: parent.tabId, label }, signal);
  }

  async start(request: StartChildRequest, signal?: AbortSignal): Promise<HostedChild> {
    const client = new HerdrSocketClient(request.parent.socketPath);
    let location: ChildLocation | undefined;
    const agentName = childName(request.taskId);
    try {
      location = await this.createLocation(client, request, signal);
      await client.call("pane.rename", { pane_id: location.paneId, label: childLabel(request) }, signal);
      await client.call("agent.start", {
        name: agentName,
        kind: "pi",
        pane_id: location.paneId,
        args: piArgs(request),
        timeout_ms: 30_000,
      }, signal);
      const info = await this.waitForSession(client, location.paneId, signal);
      const child = await this.hostedChild(request, location, agentName, info);
      this.registry?.add(child);
      return child;
    } catch (error) {
      const child = location ? await this.partialChild(request, location, agentName) : undefined;
      if (child?.terminalId) this.registry?.add(child);
      throw new StartChildError(messageOf(error), child);
    }
  }

  async prompt(child: HostedChild, prompt: string, signal?: AbortSignal): Promise<ChildSettlement> {
    const client = new HerdrSocketClient(socketPath());
    const result = await this.promptWhenRecognized(client, child.location.paneId, prompt, signal);
    const status = agentStatus(result) ?? (await this.getAgent(client, child.location.paneId, signal)).agent?.agent_status;
    return { status: status === "blocked" ? "blocked" : "settled" };
  }

  async close(child: HostedChild, signal?: AbortSignal): Promise<void> {
    const client = new HerdrSocketClient(socketPath());
    const info = await this.getAgent(client, child.location.paneId, signal);
    const current = info.agent;
    if (!current || current.pane_id !== child.location.paneId || current.terminal_id !== child.terminalId) {
      throw new HerdrProtocolError("occupant_changed", "Child pane is no longer occupied by the expected Pi");
    }
    await client.call("pane.close", { pane_id: child.location.paneId }, signal);
    this.registry?.remove(child);
  }

  private async createLocation(client: HerdrSocketClient, request: StartChildRequest, signal?: AbortSignal): Promise<ChildLocation> {
    if (request.placement === "tab") {
      const result = await client.call<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>("tab.create", {
        workspace_id: request.parent.workspaceId,
        cwd: request.context.cwd,
        label: childLabel(request),
        focus: false,
      }, signal);
      const tabId = result.tab?.tab_id;
      const paneId = result.root_pane?.pane_id;
      if (!tabId || !paneId) throw new HerdrProtocolError("invalid_response", "Herdr did not return a child tab and pane");
      return { workspaceId: request.parent.workspaceId, tabId, paneId };
    }
    const result = await client.call<{ pane?: { workspace_id?: string; tab_id?: string; pane_id?: string } }>("pane.split", {
      target_pane_id: request.parent.paneId,
      workspace_id: request.parent.workspaceId,
      cwd: request.context.cwd,
      direction: "right",
      focus: false,
    }, signal);
    const pane = result.pane;
    if (!pane?.workspace_id || !pane.tab_id || !pane.pane_id) throw new HerdrProtocolError("invalid_response", "Herdr did not return a child split");
    return { workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id };
  }

  private async hostedChild(request: StartChildRequest, location: ChildLocation, agentName: string, info: AgentInfoResponse): Promise<HostedChild> {
    const sessionPath = info.agent?.agent_session?.value;
    return {
      taskId: request.taskId,
      sessionId: request.sessionId,
      sessionPath,
      baselineEntryId: sessionPath ? await latestSessionEntryId(sessionPath) : undefined,
      location,
      agentName,
      terminalId: info.agent?.terminal_id,
    };
  }

  private async partialChild(request: StartChildRequest, location: ChildLocation, agentName: string): Promise<HostedChild> {
    try {
      return await this.hostedChild(request, location, agentName, await this.getAgent(new HerdrSocketClient(request.parent.socketPath), location.paneId));
    } catch {
      return { taskId: request.taskId, sessionId: request.sessionId, location, agentName };
    }
  }

  private async getAgent(client: HerdrSocketClient, target: string, signal?: AbortSignal): Promise<AgentInfoResponse> {
    return client.call<AgentInfoResponse>("agent.get", { target }, signal);
  }

  private async waitForSession(client: HerdrSocketClient, paneId: string, signal?: AbortSignal): Promise<AgentInfoResponse> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const info = await this.getAgent(client, paneId, signal);
      if (info.agent?.agent_session?.kind === "path" && info.agent.agent_session.value) return info;
      await delay(250, signal);
    }
    throw new HerdrProtocolError("start_timeout", "Herdr did not report the child Pi session path");
  }

  private async promptWhenRecognized(client: HerdrSocketClient, paneId: string, prompt: string, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        return await client.call("agent.prompt", { target: paneId, text: prompt, wait: {} }, signal);
      } catch (error) {
        if (!(error instanceof HerdrProtocolError) || !error.message.includes("not an active named agent") || attempt === 59) throw error;
        await delay(500, signal);
      }
    }
    throw new HerdrProtocolError("start_timeout", "Herdr did not recognize the child Pi");
  }
}

function piArgs(request: StartChildRequest): string[] {
  const args = ["--session-id", request.sessionId, "--name", childLabel(request), "--exclude-tools", "spawn_pi"];
  if (request.context.model) args.push("--model", `${request.context.model.provider}/${request.context.model.id}`);
  if (request.context.thinkingLevel) args.push("--thinking", request.context.thinkingLevel);
  if (request.rolePrompt) args.push("--append-system-prompt", request.rolePrompt);
  return args;
}

function childLabel(request: StartChildRequest): string {
  const parent = request.context.parentLabel ?? request.parent.paneId;
  return `Pi [${labelSegment(parent)}] ${request.taskId}`;
}

function labelSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "parent";
}

function childName(taskId: TaskId): string {
  return `pi_${taskId.replace(/[^a-z0-9_]/g, "_")}_${randomUUID().replaceAll("-", "").slice(0, 12)}`.slice(0, 32);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new HerdrProtocolError("aborted", "Herdr startup wait aborted"));
    }, { once: true });
  });
}

function socketPath(): string {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) throw new HerdrProtocolError("unavailable", "Herdr socket path is unavailable");
  return path;
}

async function latestSessionEntryId(sessionPath: string): Promise<string | undefined> {
  try {
    const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = JSON.parse(lines[index]) as { id?: unknown; type?: unknown };
      if (entry.type !== "session" && typeof entry.id === "string") return entry.id;
    }
  } catch {
    // A newly started Pi can report its session before the file exists; there is no baseline then.
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { agent?: { agent_status?: unknown }; agent_status?: unknown };
  return typeof record.agent?.agent_status === "string"
    ? record.agent.agent_status
    : typeof record.agent_status === "string"
      ? record.agent_status
      : undefined;
}
