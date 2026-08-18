import type { ParentContext, TaskId } from "../../src/domain.js";
import type {
  ChildHost,
  ChildSettlement,
  HostedChild,
  HostInspection,
  StartChildRequest,
} from "../../src/herdr/host.js";

export class FakeChildHost implements ChildHost {
  readonly inspection: HostInspection = {
    paneId: "w1:p1",
    socketPath: "/tmp/herdr.sock",
    tabId: "w1:t1",
    workspaceId: "w1",
  };
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
    return await Promise.resolve(this.inspection);
  }

  async renameParent(
    _parent: HostInspection,
    context: ParentContext
  ): Promise<void> {
    if (this.renameError) {
      throw this.renameError;
    }
    this.parentLabels.push(
      `Pi [${(context.parentLabel ?? this.inspection.paneId).toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "-")}]`
    );
    await Promise.resolve();
  }

  async start(
    request: StartChildRequest,
    _signal?: AbortSignal
  ): Promise<HostedChild> {
    this.startRequests.push(request);
    const error = this.startErrors.get(request.taskId);
    if (error) {
      throw error;
    }
    const child: HostedChild = {
      agentName: `pi_${request.taskId}`,
      location: {
        paneId: `w1:p${this.started.length + 2}`,
        tabId: `w1:t${this.started.length + 2}`,
        workspaceId: "w1",
      },
      sessionId: request.sessionId,
      sessionPath: this.sessionPaths.get(request.taskId),
      taskId: request.taskId,
      terminalId: `term-${request.taskId}`,
    };
    this.started.push(child);
    return await Promise.resolve(child);
  }

  async prompt(
    child: HostedChild,
    _prompt: string,
    _signal?: AbortSignal
  ): Promise<ChildSettlement> {
    const error = this.promptErrors.get(child.taskId);
    if (error) {
      throw error;
    }
    return await Promise.resolve(
      this.settlements.get(child.taskId) ?? { status: "settled" }
    );
  }

  async close(child: HostedChild, _signal?: AbortSignal): Promise<void> {
    const error = this.closeErrors.get(child.taskId);
    if (error) {
      throw error;
    }
    this.closed.push(child);
    await Promise.resolve();
  }
}

export const parentContext: ParentContext = {
  cwd: "/repo",
  model: { id: "test", provider: "openai" },
  thinkingLevel: "low",
};
