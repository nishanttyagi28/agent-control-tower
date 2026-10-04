import type { ModelSelection } from "./config.js";

export type Role = "planner" | "coder" | "reviewer";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface RoleRunRequest {
  role: Role;
  /** Short label used in logs, e.g. "coder:T1" or "coder:retry". */
  label: string;
  prompt: string;
  cwd: string;
  /** Model for this run, chosen per role by the orchestrator. */
  model: ModelSelection;
}

export type RunStatus = "finished" | "error" | "cancelled";

export interface ToolCallRecord {
  name: string;
  status: "completed" | "error";
  /** Command, path, or JSON args as reported by the SDK (untruncated, unredacted). */
  detail?: string;
  /** Filesystem paths named in the args; checked against the workspace for coder runs. */
  paths?: string[];
}

export interface RoleRunResult {
  status: RunStatus;
  /** Final assistant text for the run (empty when the run produced none). */
  text: string;
  usage?: TokenUsage;
  durationMs?: number;
  /** Finished tool calls, in order. Kept instead of raw stream events. */
  toolCalls: ToolCallRecord[];
  error?: string;
  agentId?: string;
  runId?: string;
}

/** The only seam between the orchestrator and the agent runtime. Tests use a fake. */
export interface AgentRunner {
  run(request: RoleRunRequest): Promise<RoleRunResult>;
}

export interface TestRunResult {
  exitCode: number;
  /** Combined stdout/stderr, tail-trimmed. */
  output: string;
}

export type TestRunner = (cwd: string) => Promise<TestRunResult>;

export interface PlanTask {
  id: string;
  title: string;
  instructions: string;
  /** Workspace-relative files this task may create or modify. Enforced by the scope gate. */
  files: string[];
}

export interface Plan {
  summary: string;
  tasks: PlanTask[];
}

export type Verdict = "PASS" | "FAIL";

export interface Review {
  verdict: Verdict;
  reasons: string[];
}
