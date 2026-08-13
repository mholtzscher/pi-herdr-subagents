import type { ParentContext, TaskId } from "../../src/domain.js";
import type { ChildHost, ChildSettlement, HostedChild, HostInspection, StartChildRequest } from "../../src/herdr/host.js";

export class FakeChildHost implements ChildHost {
  readonly inspection: HostInspection = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", socketPath: "/tmp/herdr.sock" };
  readonly started: HostedChild[] = [];
  readonly startRequests: StartChildRequest[] = [];
  readonly closed: HostedChild[] = [];
  readonly parentLabels: string[] = [];
  renameError?: Error;
  closeErrors = new Map<TaskId, Error>();
  settlements = new Map<TaskId, ChildSettlement>();
  startErrors = new Map<TaskId, Error>();
  promptErrors = new Map<TaskId, Error>();
  sessionPaths = new Map<TaskId, string>();

  async inspect(): Promise<HostInspection> {
    return this.inspection;
  }

  async renameParent(_parent: HostInspection, context: ParentContext): Promise<void> {
    if (this.renameError) throw this.renameError;
    this.parentLabels.push(`Pi [${(context.parentLabel ?? this.inspection.paneId).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}]`);
  }

  async start(request: StartChildRequest): Promise<HostedChild> {
    this.startRequests.push(request);
    const error = this.startErrors.get(request.taskId);
    if (error) throw error;
    const child: HostedChild = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      sessionPath: this.sessionPaths.get(request.taskId),
      location: { workspaceId: "w1", tabId: `w1:t${this.started.length + 2}`, paneId: `w1:p${this.started.length + 2}` },
      agentName: `pi_${request.taskId}`,
      terminalId: `term-${request.taskId}`,
    };
    this.started.push(child);
    return child;
  }

  async prompt(child: HostedChild, _prompt: string): Promise<ChildSettlement> {
    const error = this.promptErrors.get(child.taskId);
    if (error) throw error;
    return this.settlements.get(child.taskId) ?? { status: "settled" };
  }

  async close(child: HostedChild): Promise<void> {
    const error = this.closeErrors.get(child.taskId);
    if (error) throw error;
    this.closed.push(child);
  }
}

export const parentContext: ParentContext = { cwd: "/repo", model: { provider: "openai", id: "test" }, thinkingLevel: "low" };
