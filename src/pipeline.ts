import { RunBudget, BudgetExhaustedError } from "./budget.js";
import {
  DIFF_PROMPT_LIMIT,
  estimateCostUsd,
  LOG_TEXT_LIMIT,
  validateBudget,
  type Budget,
} from "./config.js";
import { parsePlan, parseReview, ParseError } from "./parse.js";
import { render, type PromptSet } from "./prompts.js";
import { checkpointReasons, type RetryCheckpoint } from "./retry.js";
import { tail } from "./text.js";
import { truncate } from "./tool-calls.js";
import { coderPathViolations, coderToolCallsSummary } from "./tool-scope.js";
import type {
  AgentRunner,
  Plan,
  Review,
  Role,
  RoleRunRequest,
  RoleRunResult,
  TestRunner,
  TestRunResult,
  TokenUsage,
} from "./types.js";
import { addUsage, ZERO_USAGE } from "./usage.js";
import { scopeViolations, type WorkspaceInspector, type WorkspaceSnapshot } from "./workspace.js";

export type PipelineOutcome = "PASS" | "FAIL" | "ERROR" | "BUDGET_EXHAUSTED";

export interface RunRecord {
  index: number;
  role: Role;
  label: string;
  result: RoleRunResult;
}

/** Receives every run as it completes. The CLI writes these to runs/<timestamp>/. */
export interface RunSink {
  record(entry: RunRecord, request: RoleRunRequest): Promise<void>;
}

export interface PipelineOptions {
  goal: string;
  workspace: string;
  testCommand: string;
  runner: AgentRunner;
  runTests: TestRunner;
  /** Reads git status/diff for the workspace. Feeds the reviewer and the scope gate. */
  inspectWorkspace: WorkspaceInspector;
  prompts: PromptSet;
  budget: Budget;
  sink?: RunSink;
}

export interface PipelineReport {
  outcome: PipelineOutcome;
  message: string;
  plan?: Plan;
  reviews: Review[];
  runs: RunRecord[];
  lastTests?: TestRunResult;
  lastSnapshot?: WorkspaceSnapshot;
  usage: TokenUsage;
  estCostUsd: number;
}

class RunFailedError extends Error {
  override name = "RunFailedError";
}

/** A coder broke a hard policy. Retrying cannot undo it, so the pipeline fails at once. */
class PolicyViolationError extends Error {
  override name = "PolicyViolationError";
  constructor(readonly reasons: string[]) {
    super(reasons.join("; "));
  }
}

/**
 * planner -> coder (one run per task) -> tests -> reviewer, with at most
 * budget.maxRetries coder fix rounds after a FAIL. Never loops beyond the budget.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineReport> {
  validateBudget(opts.budget);
  const budget = new RunBudget(opts.budget.maxRuns);
  const runs: RunRecord[] = [];
  const reviews: Review[] = [];
  let plan: Plan | undefined;
  let lastTests: TestRunResult | undefined;
  let lastSnapshot: WorkspaceSnapshot | undefined;

  const step = async (role: Role, label: string, prompt: string): Promise<RoleRunResult> => {
    budget.take(role);
    const request: RoleRunRequest = { role, label, prompt, cwd: opts.workspace };
    const result = await opts.runner.run(request);
    const entry: RunRecord = { index: runs.length + 1, role, label, result };
    runs.push(entry);
    await opts.sink?.record(entry, request);
    if (result.status !== "finished") {
      throw new RunFailedError(
        `${label} ended with status ${result.status}: ${result.error ?? ""}`,
      );
    }
    return result;
  };

  const review = async (p: Plan): Promise<Review> => {
    // Policy first: a coder that left the workspace fails without spending a reviewer run.
    const escapes = coderPathViolations(
      runs.map((r) => ({ role: r.role, label: r.label, calls: r.result.toolCalls })),
      opts.workspace,
    );
    if (escapes.length > 0) throw new PolicyViolationError(escapes);
    lastTests = await opts.runTests(opts.workspace);
    const snap = await opts.inspectWorkspace(opts.workspace);
    lastSnapshot = snap;
    const text = await step(
      "reviewer",
      `reviewer#${reviews.length + 1}`,
      render(opts.prompts.reviewer, {
        goal: opts.goal,
        plan: JSON.stringify(plan, null, 2),
        test_command: opts.testCommand,
        test_exit_code: String(lastTests.exitCode),
        test_output: tail(lastTests.output, LOG_TEXT_LIMIT / 2),
        git_status: snap.statusText || "(no changes)",
        git_diff: truncate(snap.diff || "(empty)", DIFF_PROMPT_LIMIT),
        tool_calls_summary: coderToolCallsSummary(
          runs.map((r) => ({ role: r.role, label: r.label, calls: r.result.toolCalls })),
        ),
      }),
    );
    const r = gateReview(
      parseReview(text.text),
      lastTests,
      scopeViolations(snap.changes, p, opts.workspace),
    );
    reviews.push(r);
    return r;
  };

  const finish = (outcome: PipelineOutcome, message: string): PipelineReport => {
    const usage = runs.reduce((acc, r) => addUsage(acc, r.result.usage), ZERO_USAGE);
    return {
      outcome,
      message,
      plan,
      reviews,
      runs,
      lastTests,
      lastSnapshot,
      usage,
      estCostUsd: estimateCostUsd(usage),
    };
  };

  try {
    // A clean start makes "what changed" exactly "what the agents changed".
    const baseline = await opts.inspectWorkspace(opts.workspace);
    if (baseline.changes.length > 0) {
      return finish(
        "ERROR",
        `workspace has uncommitted changes before the run: ${baseline.statusText}`,
      );
    }
    const planned = await step(
      "planner",
      "planner",
      render(opts.prompts.planner, { goal: opts.goal, max_tasks: String(opts.budget.maxTasks) }),
    );
    plan = parsePlan(planned.text, opts.budget.maxTasks);

    for (const task of plan.tasks) {
      await step(
        "coder",
        `coder:${task.id}`,
        coderPrompt(opts, plan, task.id, task.title, task.instructions, task.files),
      );
    }

    let verdict = await review(plan);
    for (
      let attempt = 1;
      verdict.verdict === "FAIL" && attempt <= opts.budget.maxRetries;
      attempt++
    ) {
      await step(
        "coder",
        `coder:fix${attempt}`,
        coderPrompt(
          opts,
          plan,
          `FIX${attempt}`,
          "Address reviewer findings",
          fixInstructions(
            checkpointReasons(verdict.reasons, reviews.at(-2)?.reasons),
            lastTests,
            attempt,
          ),
          plan.tasks.flatMap((t) => t.files),
        ),
      );
      verdict = await review(plan);
    }
    return verdict.verdict === "PASS"
      ? finish("PASS", "reviewer and tests passed")
      : finish(
          "FAIL",
          `reviewer FAIL after ${opts.budget.maxRetries} ${opts.budget.maxRetries === 1 ? "retry" : "retries"}: ${verdict.reasons.join("; ")}`,
        );
  } catch (err) {
    if (err instanceof BudgetExhaustedError) return finish("BUDGET_EXHAUSTED", err.message);
    if (err instanceof PolicyViolationError) {
      reviews.push({ verdict: "FAIL", reasons: err.reasons });
      return finish("FAIL", `policy violation, no retry: ${err.message}`);
    }
    if (err instanceof RunFailedError || err instanceof ParseError)
      return finish("ERROR", err.message);
    throw err;
  }
}

/**
 * Deterministic gate over the reviewer's verdict: failing tests or any changed file outside
 * the plan's declared files force FAIL, whatever the model said.
 */
export function gateReview(r: Review, tests: TestRunResult, outOfScope: string[] = []): Review {
  const forced = [
    ...(tests.exitCode !== 0 ? [`test command exited with code ${tests.exitCode}`] : []),
    ...outOfScope,
  ];
  if (forced.length === 0) return r;
  return { verdict: "FAIL", reasons: [...r.reasons, ...forced] };
}

function coderPrompt(
  opts: PipelineOptions,
  plan: Plan,
  id: string,
  title: string,
  instructions: string,
  files: string[],
): string {
  return render(opts.prompts.coder, {
    task_files: [...new Set(files)].join(", "),
    goal: opts.goal,
    plan_summary: plan.summary || "(none)",
    task_id: id,
    task_title: title,
    task_instructions: instructions,
  });
}

/**
 * Checkpointed retry: the coder continues from the current workspace and sees only the
 * findings that are still unresolved, not the history of every round.
 */
export function fixInstructions(
  cp: RetryCheckpoint,
  tests: TestRunResult | undefined,
  attempt: number,
): string {
  const reasons = cp.unresolved.length
    ? cp.unresolved
        .map((x) => `- ${cp.stillOpen.includes(x) ? "[still open] " : ""}${x}`)
        .join("\n")
    : "- (no reasons given)";
  const resolved =
    attempt > 1 && cp.resolvedCount > 0
      ? `\n\n${cp.resolvedCount} finding(s) from the previous attempt are resolved; do not revisit them.`
      : "";
  const out = tests ? tail(tests.output, LOG_TEXT_LIMIT / 3) : "(tests not run)";
  return `Retry ${attempt}. The workspace already contains the previous attempt; continue from it. Fix exactly these unresolved findings and nothing else:\n${reasons}${resolved}\n\nLast test output:\n${out}`;
}
