import { RunBudget, BudgetExhaustedError } from "./budget.js";
import { estimateCostUsd, LOG_TEXT_LIMIT, validateBudget, type Budget } from "./config.js";
import { parsePlan, parseReview, ParseError } from "./parse.js";
import { render, type PromptSet } from "./prompts.js";
import { tail } from "./text.js";
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
  usage: TokenUsage;
  estCostUsd: number;
}

class RunFailedError extends Error {
  override name = "RunFailedError";
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

  const review = async (): Promise<Review> => {
    lastTests = await opts.runTests(opts.workspace);
    const text = await step(
      "reviewer",
      `reviewer#${reviews.length + 1}`,
      render(opts.prompts.reviewer, {
        goal: opts.goal,
        plan: JSON.stringify(plan, null, 2),
        test_command: opts.testCommand,
        test_exit_code: String(lastTests.exitCode),
        test_output: tail(lastTests.output, LOG_TEXT_LIMIT / 2),
      }),
    );
    const r = gateReview(parseReview(text.text), lastTests);
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
      usage,
      estCostUsd: estimateCostUsd(usage),
    };
  };

  try {
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
        coderPrompt(opts, plan, task.id, task.title, task.instructions),
      );
    }

    let verdict = await review();
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
          fixInstructions(verdict, lastTests),
        ),
      );
      verdict = await review();
    }
    return verdict.verdict === "PASS"
      ? finish("PASS", "reviewer and tests passed")
      : finish(
          "FAIL",
          `reviewer FAIL after ${opts.budget.maxRetries} retry: ${verdict.reasons.join("; ")}`,
        );
  } catch (err) {
    if (err instanceof BudgetExhaustedError) return finish("BUDGET_EXHAUSTED", err.message);
    if (err instanceof RunFailedError || err instanceof ParseError)
      return finish("ERROR", err.message);
    throw err;
  }
}

/** The test suite is the deterministic gate: a reviewer PASS cannot override failing tests. */
export function gateReview(r: Review, tests: TestRunResult): Review {
  if (r.verdict === "PASS" && tests.exitCode !== 0) {
    return {
      verdict: "FAIL",
      reasons: [...r.reasons, `test command exited with code ${tests.exitCode}`],
    };
  }
  return r;
}

function coderPrompt(
  opts: PipelineOptions,
  plan: Plan,
  id: string,
  title: string,
  instructions: string,
): string {
  return render(opts.prompts.coder, {
    goal: opts.goal,
    plan_summary: plan.summary || "(none)",
    task_id: id,
    task_title: title,
    task_instructions: instructions,
  });
}

function fixInstructions(r: Review, tests: TestRunResult | undefined): string {
  const reasons = r.reasons.length
    ? r.reasons.map((x) => `- ${x}`).join("\n")
    : "- (no reasons given)";
  const out = tests ? tail(tests.output, LOG_TEXT_LIMIT / 3) : "(tests not run)";
  return `The reviewer returned FAIL. Fix exactly these findings and nothing else:\n${reasons}\n\nLast test output:\n${out}`;
}
