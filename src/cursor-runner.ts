import { Agent, JsonlLocalAgentStore, type SDKMessage } from "@cursor/sdk";
import { ROLE_TOOLS } from "./roles.js";
import { describeToolArgs } from "./tool-calls.js";
import { extractToolPaths } from "./tool-scope.js";
import type { AgentRunner, RoleRunRequest, RoleRunResult, ToolCallRecord } from "./types.js";

export interface CursorRunnerOptions {
  apiKey: string;
  runTimeoutMs: number;
  /** Directory for the SDK's JSONL agent store (conversation checkpoints). */
  stateDir: string;
}

/**
 * One fresh local agent per role run. Fresh agents keep each prompt's context small
 * (cheaper) and make every run reproducible from its logged prompt alone.
 */
export class CursorAgentRunner implements AgentRunner {
  private readonly store: JsonlLocalAgentStore;

  constructor(private readonly opts: CursorRunnerOptions) {
    this.store = new JsonlLocalAgentStore(opts.stateDir);
  }

  async run(req: RoleRunRequest): Promise<RoleRunResult> {
    const toolCalls: ToolCallRecord[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let agentId: string | undefined;
    try {
      await using agent = await Agent.create({
        apiKey: this.opts.apiKey,
        name: req.label,
        model: req.model,
        ...ROLE_TOOLS[req.role],
        local: { cwd: req.cwd, settingSources: ["project"], store: this.store },
      });
      agentId = agent.agentId;
      const run = await agent.send(req.prompt);
      timer = setTimeout(() => {
        timedOut = true;
        void run.cancel();
      }, this.opts.runTimeoutMs);

      for await (const ev of run.stream()) collectToolCall(ev, toolCalls);
      const res = await run.wait();
      return {
        status: res.status,
        text: res.result ?? "",
        usage: res.usage,
        durationMs: res.durationMs,
        toolCalls,
        error: timedOut ? `timed out after ${this.opts.runTimeoutMs} ms` : res.error?.message,
        agentId,
        runId: res.id,
      };
    } catch (err) {
      return {
        status: "error",
        text: "",
        toolCalls,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        agentId,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function collectToolCall(ev: SDKMessage, out: ToolCallRecord[]): void {
  if (ev.type !== "tool_call" || ev.status === "running") return;
  out.push({
    name: ev.name,
    status: ev.status,
    detail: describeToolArgs(ev.args),
    paths: extractToolPaths(ev.args),
  });
}
