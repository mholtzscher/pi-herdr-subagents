import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { roleGuidance, type ChildRolesConfigLoadResult } from "./model-routing.js";

export const ORCHESTRATOR_STATE_ENTRY = "pi-herdr-orchestrator-state";
export const ORCHESTRATOR_INSTRUCTIONS = `Orchestrator mode is enabled. You are the Parent Pi. You own task decomposition, delegation, coordination, synthesis, and final verification.

Proactively delegate useful bounded work with spawn_pi. Use Child Pis for repository exploration, independent implementation with non-overlapping ownership, and review. Batch independent tasks concurrently. Handle trivial work and tightly coupled sequential edits directly.

Children share the current checkout. Avoid overlapping writes, inspect the resulting checkout yourself, treat child reports as inputs rather than proof, and run final verification before responding.`;

const OrchestratorStateSchema = Type.Object({ enabled: Type.Boolean() });
const SessionEntrySchema = Type.Object({
  type: Type.String(),
  customType: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
});
type SessionEntry = Static<typeof SessionEntrySchema>;
const FORK_HANDOFF_KEY = "__piHerdrOrchestratorForkState";
type OrchestratorGlobal = typeof globalThis & { [FORK_HANDOFF_KEY]?: boolean };

export function findOrchestratorState(entries: readonly SessionEntry[]): boolean | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== ORCHESTRATOR_STATE_ENTRY ||
      !Check(OrchestratorStateSchema, entry.data)
    )
      continue;
    return entry.data.enabled;
  }
}

export function readOrchestratorState(path: string): boolean | undefined {
  try {
    const entries = readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line): SessionEntry[] => {
        if (!line.trim()) return [];
        try {
          const entry = JSON.parse(line);
          return Check(SessionEntrySchema, entry) ? [entry] : [];
        } catch {
          return [];
        }
      });
    return findOrchestratorState(entries);
  } catch {
    return undefined;
  }
}

export function registerOrchestrator(pi: ExtensionAPI, configResult: ChildRolesConfigLoadResult): void {
  let enabled = false;

  const available = () => configResult.ok && hasHerdrParentEnvironment() && pi.getActiveTools().includes("spawn_pi");

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("orchestrator", enabled && available() ? ctx.ui.theme.fg("accent", "orchestrator") : undefined);
  }

  function persist(): void {
    pi.appendEntry(ORCHESTRATOR_STATE_ENTRY, { enabled });
  }

  function setEnabled(next: boolean, ctx: ExtensionContext): void {
    if (next && !available()) {
      enabled = false;
      updateStatus(ctx);
      ctx.ui.notify(unavailableMessage(configResult), "warning");
      return;
    }
    enabled = next;
    persist();
    updateStatus(ctx);
    ctx.ui.notify(`Orchestrator mode ${enabled ? "enabled" : "disabled"}.`, "info");
  }

  pi.registerCommand("orchestrator", {
    description: "Toggle or inspect Parent orchestrator mode",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "status", "toggle"];
      const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "status") {
        const message = available()
          ? `Orchestrator mode is ${enabled ? "enabled" : "disabled"}.`
          : unavailableMessage(configResult);
        const roles = configResult.ok
          ? (roleGuidance(configResult.config) ?? "Configured Child Roles: none")
          : undefined;
        ctx.ui.notify(roles ? `${message}\n${roles}` : message, available() ? "info" : "warning");
        return;
      }
      if (action === "off") return setEnabled(false, ctx);
      if (!available()) {
        ctx.ui.notify(unavailableMessage(configResult), "warning");
        return;
      }
      if (action === "on") return setEnabled(true, ctx);
      if (action === "toggle") return setEnabled(!enabled, ctx);
      ctx.ui.notify("Usage: /orchestrator [on|off|status|toggle]", "error");
    },
  });

  pi.on("session_before_fork", () => {
    // SAFETY: This extension owns FORK_HANDOFF_KEY on globalThis and stores only the local boolean state.
    (globalThis as OrchestratorGlobal)[FORK_HANDOFF_KEY] = enabled;
  });

  pi.on("session_start", (event, ctx) => {
    // SAFETY: This extension owns FORK_HANDOFF_KEY on globalThis and reads it only as an optional boolean.
    const shared = globalThis as OrchestratorGlobal;
    const memoryHandoff = event.reason === "fork" ? shared[FORK_HANDOFF_KEY] : undefined;
    delete shared[FORK_HANDOFF_KEY];
    const entries = ctx.sessionManager.getEntries();
    const stored = findOrchestratorState(entries);
    const fileHandoff =
      event.reason === "fork" && event.previousSessionFile
        ? readOrchestratorState(event.previousSessionFile)
        : undefined;
    const inherited = memoryHandoff ?? fileHandoff;
    enabled = inherited ?? stored ?? (configResult.ok ? configResult.config.orchestrator.enabled : false);

    if (!configResult.ok) {
      enabled = false;
      if (ctx.hasUI) ctx.ui.notify(unavailableMessage(configResult), "warning");
    } else if (available() && (inherited !== undefined || stored === undefined)) {
      persist();
    }
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    updateStatus(ctx);
    if (!enabled || !available()) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_INSTRUCTIONS}` };
  });
}

function hasHerdrParentEnvironment(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    Boolean(process.env.HERDR_WORKSPACE_ID) &&
    Boolean(process.env.HERDR_TAB_ID) &&
    Boolean(process.env.HERDR_PANE_ID) &&
    Boolean(process.env.HERDR_SOCKET_PATH)
  );
}

function unavailableMessage(configResult: ChildRolesConfigLoadResult): string {
  return configResult.ok
    ? "Orchestrator mode requires a Herdr Parent with spawn_pi active."
    : `Invalid config at ${configResult.path}: ${configResult.error}. Orchestrator mode is disabled and spawn_pi is blocked.`;
}
