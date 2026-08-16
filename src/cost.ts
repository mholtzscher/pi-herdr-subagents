import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import type { ChildResult, TaskId } from "./domain.js";
// oxlint-disable unicorn/no-useless-undefined
import { HerdrSocketClient } from "./herdr/protocol.js";

export type ChildCostStatus =
  | "complete"
  | "running"
  | "blocked"
  | "open"
  | "unavailable";

export interface ChildCostSnapshot {
  taskId: TaskId;
  sessionId?: string;
  sessionPath?: string;
  status: ChildCostStatus;
  /** Undefined only when the child session is unavailable. */
  cost?: number;
}

export interface OrchestratorCostSnapshot {
  parentCost: number;
  children: ChildCostSnapshot[];
  childrenCost: number;
  totalCost: number;
}

export type ChildStatusLookup = (
  child: ChildResult
) => Promise<ChildCostStatus | undefined>;

const CostSchema = Type.Object(
  { total: Type.Number({ minimum: 0 }) },
  { additionalProperties: true }
);
const UsageSchema = Type.Object(
  { cost: CostSchema },
  { additionalProperties: true }
);
const AssistantUsageMessageSchema = Type.Object(
  { role: Type.Literal("assistant"), usage: UsageSchema },
  { additionalProperties: true }
);
const ToolUsageMessageSchema = Type.Object(
  {
    role: Type.Literal("toolResult"),
    usage: Type.Optional(UsageSchema),
  },
  { additionalProperties: true }
);
const UsageEntrySchema = Type.Object(
  {
    message: Type.Optional(Type.Unknown()),
    type: Type.String(),
    usage: Type.Optional(UsageSchema),
  },
  { additionalProperties: true }
);

const ChildLocationSchema = Type.Object(
  {
    paneId: Type.String(),
    tabId: Type.String(),
    workspaceId: Type.String(),
  },
  { additionalProperties: true }
);
const ChildErrorSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("role_not_found"),
      Type.Literal("model_routing_failed"),
      Type.Literal("start_failed"),
      Type.Literal("prompt_failed"),
      Type.Literal("result_unreadable"),
      Type.Literal("blocked"),
      Type.Literal("parent_aborted"),
    ]),
    message: Type.String(),
  },
  { additionalProperties: true }
);
const ChildSelectionSchema = Type.Object(
  {
    model: Type.Optional(
      Type.Object(
        { id: Type.String(), provider: Type.String() },
        { additionalProperties: true }
      )
    ),
    modelSource: Type.Optional(
      Type.Union([
        Type.Literal("explicit"),
        Type.Literal("role"),
        Type.Literal("default"),
        Type.Literal("parent"),
      ])
    ),
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ])
    ),
    thinkingSource: Type.Optional(
      Type.Union([
        Type.Literal("explicit"),
        Type.Literal("role"),
        Type.Literal("default"),
        Type.Literal("parent"),
      ])
    ),
  },
  { additionalProperties: true }
);
const ChildResultSchema = Type.Object(
  {
    error: Type.Optional(ChildErrorSchema),
    location: Type.Optional(ChildLocationSchema),
    paneClosed: Type.Boolean(),
    requestIndex: Type.Integer({ minimum: 0 }),
    role: Type.Optional(Type.String()),
    selection: Type.Optional(ChildSelectionSchema),
    sessionId: Type.Optional(Type.String()),
    sessionPath: Type.Optional(Type.String()),
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("blocked"),
      Type.Literal("unattributable"),
      Type.Literal("parent_aborted"),
    ]),
    summary: Type.Optional(Type.String()),
    taskId: Type.String({ pattern: "^task-[0-9]+$" }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: true }
);
const SpawnBatchResultSchema = Type.Object(
  {
    requested: Type.Integer({ minimum: 0 }),
    results: Type.Array(ChildResultSchema),
  },
  { additionalProperties: true }
);
const FinishedDetailsSchema = Type.Object(
  {
    phase: Type.Literal("finished"),
    result: SpawnBatchResultSchema,
  },
  { additionalProperties: true }
);
const ToolResultEntrySchema = Type.Object(
  {
    message: Type.Object(
      {
        details: Type.Optional(Type.Unknown()),
        isError: Type.Literal(false),
        role: Type.Literal("toolResult"),
        toolName: Type.Literal("spawn_pi"),
      },
      { additionalProperties: true }
    ),
    type: Type.Literal("message"),
  },
  { additionalProperties: true }
);
const SessionHeaderSchema = Type.Object(
  {
    cwd: Type.String(),
    id: Type.String(),
    parentSession: Type.Optional(Type.String()),
    timestamp: Type.String(),
    type: Type.Literal("session"),
    version: Type.Optional(Type.Number()),
  },
  { additionalProperties: true }
);
const AgentSessionSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    value: Type.String(),
  },
  { additionalProperties: true }
);
const AgentGetResponseSchema = Type.Object(
  {
    agent: Type.Object(
      {
        agent_session: AgentSessionSchema,
        agent_status: Type.String(),
        pane_id: Type.String(),
        tab_id: Type.String(),
        workspace_id: Type.String(),
      },
      { additionalProperties: true }
    ),
  },
  { additionalProperties: true }
);
type PersistedUsage = Static<typeof UsageSchema>;

const isTaskId = (value: string): value is TaskId =>
  /^task-[0-9]+$/u.test(value);

// Persisted tool details enter through this schema-checking boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const parseChildResult = (value: unknown): ChildResult | undefined => {
  if (!Check(ChildResultSchema, value) || !isTaskId(value.taskId)) {
    return undefined;
  }
  return { ...value, taskId: value.taskId };
};

const parseSpawnBatchResult = (
  // Persisted tool details enter through this schema-checking boundary.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  value: unknown
): { children: ChildResult[] } | undefined => {
  if (!Check(SpawnBatchResultSchema, value)) {
    return undefined;
  }
  const children = value.results.flatMap((child) => {
    const parsed = parseChildResult(child);
    return parsed === undefined ? [] : [parsed];
  });
  return children.length === value.results.length ? { children } : undefined;
};

const costOf = (value: PersistedUsage | undefined): number =>
  value?.cost.total ?? 0;

export const usageCost = (entries: readonly SessionEntry[]): number => {
  let total = 0;
  for (const entry of entries) {
    if (!Check(UsageEntrySchema, entry)) {
      continue;
    }
    if (
      entry.type === "message" &&
      Check(AssistantUsageMessageSchema, entry.message)
    ) {
      total += costOf(entry.message.usage);
      continue;
    }
    if (
      entry.type === "message" &&
      Check(ToolUsageMessageSchema, entry.message)
    ) {
      total += costOf(entry.message.usage);
      continue;
    }
    if (
      (entry.type === "compaction" || entry.type === "branch_summary") &&
      entry.usage !== undefined
    ) {
      total += costOf(entry.usage);
    }
  }
  return total;
};

const childIdentity = (child: ChildResult): string | undefined => {
  if (child.sessionId !== undefined && child.sessionId.length > 0) {
    return `id:${child.sessionId}`;
  }
  if (child.sessionPath !== undefined && child.sessionPath.length > 0) {
    return `path:${path.resolve(child.sessionPath)}`;
  }
  return undefined;
};

export const discoverSpawnedChildren = (
  entries: readonly SessionEntry[]
): ChildResult[] => {
  const children: ChildResult[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!Check(ToolResultEntrySchema, entry)) {
      continue;
    }
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Check narrowed the persisted tool-result message schema.
    const { details } = entry.message;
    const parsed = Check(FinishedDetailsSchema, details)
      ? parseSpawnBatchResult(details.result)
      : parseSpawnBatchResult(details);
    if (parsed === undefined) {
      continue;
    }
    // oxlint-disable-next-line unicorn/no-array-sort
    for (const child of [...parsed.children].sort(
      (left, right) => left.requestIndex - right.requestIndex
    )) {
      const identity = childIdentity(child);
      if (identity === undefined || seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      children.push(child);
    }
  }
  return children;
};

const fallbackStatus = (child: ChildResult): ChildCostStatus => {
  if (child.status === "succeeded") {
    return "complete";
  }
  if (child.status === "blocked") {
    return "blocked";
  }
  return "open";
};

const unavailableSnapshot = (child: ChildResult): ChildCostSnapshot => {
  const snapshot: ChildCostSnapshot = {
    status: "unavailable",
    taskId: child.taskId,
  };
  if (child.sessionId !== undefined) {
    snapshot.sessionId = child.sessionId;
  }
  if (child.sessionPath !== undefined) {
    snapshot.sessionPath = child.sessionPath;
  }
  return snapshot;
};

const readChildEntries = async (
  sessionPath: string
): Promise<SessionEntry[]> => {
  const raw = await readFile(sessionPath, "utf-8");
  const entries = parseSessionEntries(raw);
  if (!Check(SessionHeaderSchema, entries[0])) {
    throw new Error("Child session header is invalid");
  }
  return entries.filter(
    (entry): entry is SessionEntry => entry.type !== "session"
  );
};

export const readOrchestratorCost = async (
  parentEntries: readonly SessionEntry[],
  lookupStatus: ChildStatusLookup
): Promise<OrchestratorCostSnapshot> => {
  const children = discoverSpawnedChildren(parentEntries);
  const reads = new Map<string, Promise<SessionEntry[]>>();
  const snapshots = await Promise.all(
    children.map(async (child): Promise<ChildCostSnapshot> => {
      const { sessionPath } = child;
      if (sessionPath === undefined || sessionPath.length === 0) {
        return unavailableSnapshot(child);
      }
      const resolvedPath = path.resolve(sessionPath);
      let read = reads.get(resolvedPath);
      if (read === undefined) {
        read = readChildEntries(sessionPath);
        reads.set(resolvedPath, read);
      }
      let entries: SessionEntry[];
      try {
        entries = await read;
      } catch {
        return unavailableSnapshot(child);
      }
      let status: ChildCostStatus | undefined;
      try {
        status = await lookupStatus(child);
      } catch {
        status = undefined;
      }
      const snapshot: ChildCostSnapshot = {
        cost: usageCost(entries),
        sessionPath,
        status: status ?? fallbackStatus(child),
        taskId: child.taskId,
      };
      if (child.sessionId !== undefined) {
        snapshot.sessionId = child.sessionId;
      }
      return snapshot;
    })
  );
  const childrenCost = snapshots.reduce(
    (total, child) => total + (child.cost ?? 0),
    0
  );
  const parentCost = usageCost(parentEntries);
  return {
    children: snapshots,
    childrenCost,
    parentCost,
    totalCost: parentCost + childrenCost,
  };
};

const identifierOf = (child: ChildCostSnapshot): string => {
  if (child.sessionId !== undefined && child.sessionId.length > 0) {
    return child.sessionId.slice(0, 8);
  }
  if (child.sessionPath !== undefined && child.sessionPath.length > 0) {
    const name = path.basename(child.sessionPath).replace(/\.jsonl$/u, "");
    if (name.length > 0) {
      return name.slice(0, 8);
    }
  }
  return "unknown";
};

const money = (value: number | undefined): string =>
  value === undefined ? "—" : `$${value.toFixed(4)}`;

export const formatOrchestratorCost = (
  snapshot: OrchestratorCostSnapshot
): string => {
  const labels = snapshot.children.map(
    (child) => `  ${child.taskId} · ${identifierOf(child)} · ${child.status}`
  );
  const labelWidth = Math.max(
    35,
    "Parent".length,
    "Children subtotal".length,
    "Total".length,
    ...labels.map((label) => label.length)
  );
  const row = (label: string, value: number | undefined): string =>
    `${label.padEnd(labelWidth)} ${money(value)}`;
  const childLines = labels.length
    ? [
        "Children",
        ...snapshot.children.map((child, index) =>
          row(labels[index] ?? "", child.cost)
        ),
      ]
    : ["Children  none"];
  return [
    "Orchestrator cost · current session",
    "",
    row("Parent", snapshot.parentCost),
    ...childLines,
    row("Children subtotal", snapshot.childrenCost),
    row("Total", snapshot.totalCost),
  ].join("\n");
};

const statusOf = (status: string): ChildCostStatus | undefined => {
  if (status === "working") {
    return "running";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "idle") {
    return "open";
  }
  return undefined;
};

const hasChildIdentity = (child: ChildResult): boolean =>
  (child.sessionId?.length ?? 0) > 0 || (child.sessionPath?.length ?? 0) > 0;

const matchesLocation = (
  child: ChildResult,
  agent: StaticAgentGetResponse["agent"]
): boolean =>
  child.location !== undefined &&
  agent.workspace_id === child.location.workspaceId &&
  agent.tab_id === child.location.tabId &&
  agent.pane_id === child.location.paneId;

const matchesSession = (
  child: ChildResult,
  agentSession: StaticAgentGetResponse["agent"]["agent_session"]
): boolean => {
  if (agentSession.kind === "id") {
    return (
      (child.sessionId?.length ?? 0) > 0 &&
      agentSession.value === child.sessionId
    );
  }
  return (
    (child.sessionPath?.length ?? 0) > 0 &&
    path.resolve(agentSession.value) === path.resolve(child.sessionPath ?? "")
  );
};

interface StaticAgentGetResponse {
  agent: {
    agent_session: { kind: "id" | "path"; value: string };
    agent_status: string;
    pane_id: string;
    tab_id: string;
    workspace_id: string;
  };
}

export const lookupHerdrChildStatus: ChildStatusLookup = async (child) => {
  const { location } = child;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (
    location === undefined ||
    location.workspaceId.length === 0 ||
    location.tabId.length === 0 ||
    location.paneId.length === 0 ||
    socketPath === undefined ||
    socketPath.length === 0 ||
    !hasChildIdentity(child)
  ) {
    return undefined;
  }
  const response = await new HerdrSocketClient(socketPath)
    .call("agent.get", { target: location.paneId })
    .catch(() => undefined);
  if (!Check(AgentGetResponseSchema, response)) {
    return undefined;
  }
  const { agent } = response;
  if (
    !matchesLocation(child, agent) ||
    !matchesSession(child, agent.agent_session)
  ) {
    return undefined;
  }
  return statusOf(agent.agent_status);
};
