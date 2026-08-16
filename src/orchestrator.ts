import { readFileSync } from "node:fs";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Check } from "typebox/value";

import { formatOrchestratorCost, readOrchestratorCost } from "./cost.js";
import type { ChildStatusLookup } from "./cost.js";
import type { ChildRolesConfigLoadResult } from "./model-routing.js";

export const ORCHESTRATOR_STATE_ENTRY = "pi-herdr-orchestrator-state";
export const ORCHESTRATOR_INSTRUCTIONS = `Orchestrator mode is enabled. You are the Parent Pi. You own task decomposition, delegation, coordination, synthesis, and final verification.

Proactively delegate useful bounded work with spawn_pi. Use Child Pis for repository exploration, independent implementation with non-overlapping ownership, and review. Batch independent tasks concurrently. Handle trivial work and tightly coupled sequential edits directly.

Children share the current checkout. Avoid overlapping writes, inspect the resulting checkout yourself, treat child reports as inputs rather than proof, and run final verification before responding.`;

const OrchestratorStateSchema = Type.Object({ enabled: Type.Boolean() });
const SessionEntrySchema = Type.Object({
  customType: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
  type: Type.String(),
});
type SessionEntry = Static<typeof SessionEntrySchema>;
type OrchestratorGlobal = typeof globalThis & {
  __piHerdrOrchestratorForkState?: boolean;
};

export const findOrchestratorState = (
  entries: readonly SessionEntry[]
): boolean | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== ORCHESTRATOR_STATE_ENTRY ||
      !Check(OrchestratorStateSchema, entry.data)
    ) {
      continue;
    }
    return entry.data.enabled;
  }
  return undefined;
};

export const readOrchestratorState = (path: string): boolean | undefined => {
  try {
    const entries = readFileSync(path, "utf-8")
      .split("\n")
      .flatMap((line): SessionEntry[] => {
        if (!line.trim()) {
          return [];
        }
        try {
          const entry: unknown = JSON.parse(line);
          return Check(SessionEntrySchema, entry) ? [entry] : [];
        } catch {
          return [];
        }
      });
    return findOrchestratorState(entries);
  } catch {
    return undefined;
  }
};

const hasHerdrParentEnvironment = (): boolean =>
  process.env.HERDR_ENV === "1" &&
  Boolean(process.env.HERDR_WORKSPACE_ID) &&
  Boolean(process.env.HERDR_TAB_ID) &&
  Boolean(process.env.HERDR_PANE_ID) &&
  Boolean(process.env.HERDR_SOCKET_PATH);

const unavailableMessage = (
  configResult: ChildRolesConfigLoadResult
): string =>
  configResult.ok
    ? "△ Orchestrator unavailable\n  Requires a Herdr Parent with spawn_pi active."
    : `! Orchestrator disabled — invalid config\n  ${configResult.path}\n  ${configResult.error}\n  spawn_pi blocked`;

export const registerOrchestrator = (
  pi: ExtensionAPI,
  configResult: ChildRolesConfigLoadResult,
  lookupChildStatus: ChildStatusLookup
): void => {
  let enabled = false;

  const available = () =>
    configResult.ok &&
    hasHerdrParentEnvironment() &&
    pi.getActiveTools().includes("spawn_pi");

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      "orchestrator",
      enabled && available()
        ? ctx.ui.theme.fg("accent", "orchestrator")
        : undefined
    );
  };

  const persist = (): void => {
    pi.appendEntry(ORCHESTRATOR_STATE_ENTRY, { enabled });
  };

  const setEnabled = (next: boolean, ctx: ExtensionContext): void => {
    if (next && !available()) {
      enabled = false;
      updateStatus(ctx);
      ctx.ui.notify(unavailableMessage(configResult), "warning");
      return;
    }
    enabled = next;
    persist();
    updateStatus(ctx);
    ctx.ui.notify(
      enabled ? "✓ Orchestrator enabled" : "○ Orchestrator disabled",
      "info"
    );
  };

  pi.registerCommand("orchestrator", {
    description: "Toggle or inspect Parent orchestrator mode",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "status", "cost", "toggle"];
      const matches = values
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ label: value, value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "cost") {
        const snapshot = await readOrchestratorCost(
          ctx.sessionManager.getEntries(),
          lookupChildStatus
        );
        ctx.ui.notify(formatOrchestratorCost(snapshot), "info");
        return;
      }
      if (action === "status") {
        const isAvailable = available();
        const message = isAvailable
          ? `${enabled ? "●" : "○"} Orchestrator ${enabled ? "enabled" : "disabled"}`
          : unavailableMessage(configResult);
        const roles =
          isAvailable && configResult.ok
            ? Object.entries(configResult.config.roles)
                .map(([name, role]) =>
                  role.description !== undefined && role.description.length > 0
                    ? `${name} (${role.description})`
                    : name
                )
                .join(" · ") || "none"
            : undefined;
        ctx.ui.notify(
          roles === undefined ? message : `${message}\n  Roles  ${roles}`,
          isAvailable ? "info" : "warning"
        );
        return;
      }
      if (action === "off") {
        setEnabled(false, ctx);
        return;
      }
      if (!available()) {
        ctx.ui.notify(unavailableMessage(configResult), "warning");
        return;
      }
      if (action === "on") {
        setEnabled(true, ctx);
        return;
      }
      if (action === "toggle") {
        setEnabled(!enabled, ctx);
        return;
      }
      ctx.ui.notify(
        "! Usage: /orchestrator [on|off|status|cost|toggle]",
        "error"
      );
    },
  });

  pi.on("session_before_fork", () => {
    // SAFETY: This extension owns __piHerdrOrchestratorForkState on globalThis and stores only the local boolean state.
    (globalThis as OrchestratorGlobal).__piHerdrOrchestratorForkState = enabled;
  });

  pi.on("session_start", (event, ctx) => {
    // SAFETY: This extension owns __piHerdrOrchestratorForkState on globalThis and reads it only as an optional boolean.
    const shared = globalThis as OrchestratorGlobal;
    const memoryHandoff =
      event.reason === "fork"
        ? shared.__piHerdrOrchestratorForkState
        : undefined;
    delete shared.__piHerdrOrchestratorForkState;
    const entries = ctx.sessionManager.getEntries();
    const stored = findOrchestratorState(entries);
    const fileHandoff =
      event.reason === "fork" &&
      event.previousSessionFile !== undefined &&
      event.previousSessionFile.length > 0
        ? readOrchestratorState(event.previousSessionFile)
        : undefined;
    const inherited = memoryHandoff ?? fileHandoff;
    enabled =
      inherited ??
      stored ??
      (configResult.ok ? configResult.config.orchestrator.enabled : false);

    if (!configResult.ok) {
      enabled = false;
      if (ctx.hasUI) {
        ctx.ui.notify(unavailableMessage(configResult), "warning");
      }
    } else if (
      available() &&
      (inherited !== undefined || stored === undefined)
    ) {
      persist();
    }
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    updateStatus(ctx);
    return enabled && available()
      ? {
          systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_INSTRUCTIONS}`,
        }
      : undefined;
  });
};
