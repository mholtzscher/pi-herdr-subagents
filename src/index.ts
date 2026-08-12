import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConcurrentBatchRunner } from "./batch.js";
import { HerdrChildHost, SessionChildRegistry } from "./herdr/host.js";
import { loadOrCreateParentLabel, PARENT_LABEL_ENTRY } from "./parent-label.js";
import { JsonlChildResultReader } from "./results.js";
import { loadChildRolesConfig } from "./model-routing.js";
import { registerSpawnPiTool } from "./tools.js";

export default function (pi: ExtensionAPI): void {
  const children = new SessionChildRegistry();
  const host = new HerdrChildHost(children);
  const childRolesConfig = loadChildRolesConfig();
  let parentLabel: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    parentLabel = loadOrCreateParentLabel(ctx.sessionManager.getEntries(), (label) => {
      pi.appendEntry(PARENT_LABEL_ENTRY, { label });
    });
  });

  registerSpawnPiTool(pi, new ConcurrentBatchRunner(host, new JsonlChildResultReader()), () => {
    if (!parentLabel) throw new Error("Parent label is unavailable before session start");
    return parentLabel;
  }, childRolesConfig);

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") return;
    await children.closeAll(host);
  });
}
