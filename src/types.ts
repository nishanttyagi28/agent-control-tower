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
}

export type RunStatus = "finished" | "error" | "cancelled";

export interface RoleRunResult {
  status: RunStatus;
  /** Final assistant text for the run (empty when the run produced none). */
  text: string;
  usage?: TokenUsage;
  durationMs?: number;
  /** Names of completed tool calls, in order. Kept instead of raw stream events. */
  toolCalls: string[];
  error?: string;
  agentId?: string;
  runId?: string;
}

/** The only seam between the orchestrator and Cursor. Tests use a fake. */
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
