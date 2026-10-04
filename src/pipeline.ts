import { crossesThreshold, DEFAULT_CONFIRM_THRESHOLD, type Approver } from "./approve.js";
import { RunBudget, BudgetExhaustedError } from "./budget.js";
import type { Checkpoint, WorkspaceCheckpointer } from "./checkpoint.js";
import {
  DIFF_PROMPT_LIMIT,
  DEFAULT_ROLE_MODELS,
  estimateCostUsd,
  MODEL_PRICES,
  type RoleModels,
  LOG_TEXT_LIMIT,
  validateBudget,
  type Budget,
} from "./config.js";
import { parsePlan, parseReview, ParseError } from "./parse.js";
import { render, type PromptSet } from "./prompts.js";
import { ROLE_TOOLS, type ToolPolicy } from "./roles.js";
import {
  checkpointReasons,
  DEFAULT_DUPLICATE_FAILURE,
  FailureTracker,
  type DuplicateFailurePolicy,
  type RetryCheckpoint,
} from "./retry.js";
import { tail } from "./text.js";
import { truncate } from "./tool-calls.js";
import { policyEvents, validateRoleTools, type PolicyEvent } from "./tool-gate.js";
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

export type PipelineOutcome =
  "PASS" | "FAIL" | "DUPLICATE_FAILURE" | "STOPPED_BY_USER" | "ERROR" | "BUDGET_EXHAUSTED";

export interface RunRecord {
  index: number;
  role: Role;
  label: string;
  /** Model id the run used. */
  model: string;
  result: RoleRunResult;
}

/** Receives every run as it completes. The CLI writes these to runs/<timestamp>/. */
export interface RunSink {
  record(entry: RunRecord, request: RoleRunRequest): Promise<void>;
}

export interface FailureArtifacts {
  /** Diff from the pre-pipeline state to the final (failed) state, workspace-relative. */
  failedDiff: string;
  /** Ref that still holds the failed state, for inspection after the restore. */
  failedRef: string;
  /** Paths restored to their pre-pipeline content (or removed, if the agents created them). */
  restored: string[];
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
  /** Model per role. Default: composer-2.5 (fast=false) for all three. */
  models?: RoleModels;
  /**
   * Checkpoints the workspace before the run and at every review (i.e. before each retry).
   * Enables the "diff since last review" for the reviewer and the restore on failure.
   */
  checkpoints?: WorkspaceCheckpointer;
  /**
   * Human in the loop (--interactive). Asked before the run that crosses `confirmThreshold`
   * of maxRuns and before every retry after a FAIL. Absent: never asks (the default).
   */
  approve?: Approver;
  /** Fraction of maxRuns that triggers a confirmation. Default 0.8. */
  confirmThreshold?: number;
  /** Abort when a retry repeats earlier failures. Default: enabled, 0.8 overlap. */
  duplicateFailure?: DuplicateFailurePolicy;
  sink?: RunSink;
  /** Per-role tool allowlists. Default: ROLE_TOOLS. */
  roleTools?: Record<Role, ToolPolicy>;
  /** Orchestrator-approved shell commands; empty means shell tools are rejected. */
  commandAllowlist?: readonly string[];
}

export interface PipelineReport {
  outcome: PipelineOutcome;
  message: string;
  plan?: Plan;
  reviews: Review[];
  runs: RunRecord[];
  lastTests?: TestRunResult;
  lastSnapshot?: WorkspaceSnapshot;
  /** Set when the pipeline did not PASS after agents ran and checkpoints are enabled. */
  failure?: FailureArtifacts;
  checkpointRefs: string[];
  usage: TokenUsage;
  /** List-price estimate over runs whose model has a known price. */
  estCostUsd: number;
  /** Models used without a known price; their runs are not in estCostUsd. */
  unpricedModels: string[];
  policyEvents: PolicyEvent[];
}

class RunFailedError extends Error {
  override name = "RunFailedError";
}

class StoppedByUserError extends Error {
  override name = "StoppedByUserError";
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
  const roleTools = opts.roleTools ?? ROLE_TOOLS;
  const commandAllowlist = opts.commandAllowlist ?? [];
  const budget = new RunBudget(opts.budget.maxRuns);
  const runs: RunRecord[] = [];
  const reviews: Review[] = [];
  let plan: Plan | undefined;
  let lastTests: TestRunResult | undefined;
  let lastSnapshot: WorkspaceSnapshot | undefined;
  const dup = opts.duplicateFailure ?? DEFAULT_DUPLICATE_FAILURE;
  const failures = new FailureTracker();
  const refs: string[] = [];
  let base: Checkpoint | undefined;
  let lastReviewCheckpoint: Checkpoint | undefined;
  let failure: FailureArtifacts | undefined;
  const checkpoint = async (label: string) => {
    const cp = await opts.checkpoints?.checkpoint(label);
    if (cp) refs.push(cp.ref);
    return cp;
  };

  const threshold = opts.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
  let thresholdAsked = false;
  const ask = async (
    reason: "budget_threshold" | "after_fail",
    nextLabel: string,
    detail?: string,
  ) => {
    if (!opts.approve) return;
    if (crossesThreshold(budget.runsUsed + 1, opts.budget.maxRuns, threshold))
      thresholdAsked = true;
    const yes = await opts.approve({
      reason,
      nextLabel,
      runsUsed: budget.runsUsed,
      maxRuns: opts.budget.maxRuns,
      detail,
    });
    if (!yes) throw new StoppedByUserError(`stopped by user before ${nextLabel} (${reason})`);
  };

  const step = async (role: Role, label: string, prompt: string): Promise<RoleRunResult> => {
    if (!thresholdAsked && crossesThreshold(budget.runsUsed + 1, opts.budget.maxRuns, threshold)) {
      await ask("budget_threshold", label);
    }
    budget.take(role);
    const model = (opts.models ?? DEFAULT_ROLE_MODELS)[role];
    const request: RoleRunRequest = { role, label, prompt, cwd: opts.workspace, model };
    const result = await opts.runner.run(request);
    const entry: RunRecord = { index: runs.length + 1, role, label, model: model.id, result };
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
    // This checkpoint is also the pre-retry checkpoint if the review FAILs.
    const current = await checkpoint(`review-${reviews.length + 1}`);
    const sinceLast =
      !opts.checkpoints || !current
        ? "(checkpoints disabled)"
        : lastReviewCheckpoint
          ? (await opts.checkpoints.diff(lastReviewCheckpoint, current)) ||
            "(no changes since last review)"
          : "(first review: same as the full diff)";
    lastReviewCheckpoint = current;
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
        diff_since_last_review: truncate(sinceLast, DIFF_PROMPT_LIMIT / 2),
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
    if (failure?.restored) {
      message += ` (workspace restored, ${failure.restored.length} path(s); failed state kept at ${failure.failedRef})`;
    }
    const usage = runs.reduce((acc, r) => addUsage(acc, r.result.usage), ZERO_USAGE);
    return {
      outcome,
      message,
      plan,
      reviews,
      runs,
      lastTests,
      lastSnapshot,
      failure,
      checkpointRefs: refs,
      usage,
      ...costOf(runs),
      policyEvents: policyEvents(
        runs.map((r) => ({ role: r.role, label: r.label, calls: r.result.toolCalls })),
      ),
    };
  };

  const toolGateMessages = validateRoleTools(roleTools, commandAllowlist);
  if (toolGateMessages.length > 0) {
    return finish("ERROR", toolGateMessages.join("; "));
  }

  try {
    // A clean start makes "what changed" exactly "what the agents changed".
    const baseline = await opts.inspectWorkspace(opts.workspace);
    if (baseline.changes.length > 0) {
      return finish(
        "ERROR",
        `workspace has uncommitted changes before the run: ${baseline.statusText}`,
      );
    }
    base = await checkpoint("base");
    const report = await stages();
    if (report.outcome !== "PASS") await restoreAfterFailure();
    return finish(report.outcome, report.message);
  } catch (err) {
    await restoreAfterFailure();
    throw err;
  }

  /** On any non-PASS outcome: save the failed diff, then put the workspace back. */
  async function restoreAfterFailure(): Promise<void> {
    if (!opts.checkpoints || !base || failure) return;
    const failed = await checkpoint("failed");
    if (!failed) return;
    const failedDiff = await opts.checkpoints.diff(base, failed);
    const restored = await opts.checkpoints.restore(base);
    failure = { failedDiff, failedRef: failed.ref, restored };
  }

  async function stages(): Promise<{ outcome: PipelineOutcome; message: string }> {
    const result = (outcome: PipelineOutcome, message: string) => ({ outcome, message });
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
          coderPrompt(opts, plan, task.id, task.title, task.instructions, task.files),
        );
      }

      let verdict = await review(plan);
      if (verdict.verdict === "FAIL") failures.observe(verdict.reasons, lastTests?.output);
      for (
        let attempt = 1;
        verdict.verdict === "FAIL" && attempt <= opts.budget.maxRetries;
        attempt++
      ) {
        await ask(
          "after_fail",
          `coder:fix${attempt}`,
          verdict.reasons.map((r) => `  - ${r}`).join("\n"),
        );
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
        if (verdict.verdict === "FAIL") {
          const seen = failures.observe(verdict.reasons, lastTests?.output);
          // Only worth aborting when another retry would otherwise be spent.
          const moreRetriesLeft = attempt < opts.budget.maxRetries;
          if (
            dup.enabled &&
            moreRetriesLeft &&
            seen.comparable > 0 &&
            seen.overlap >= dup.overlapThreshold
          ) {
            return result(
              "DUPLICATE_FAILURE",
              `retry ${attempt} repeated ${seen.repeated.length}/${seen.comparable} earlier ` +
                `failure reasons (threshold ${dup.overlapThreshold}): ${seen.repeated.join("; ")}`,
            );
          }
        }
      }
      return verdict.verdict === "PASS"
        ? result("PASS", "reviewer and tests passed")
        : result(
            "FAIL",
            `reviewer FAIL after ${opts.budget.maxRetries} ${opts.budget.maxRetries === 1 ? "retry" : "retries"}: ${verdict.reasons.join("; ")}`,
          );
    } catch (err) {
      if (err instanceof BudgetExhaustedError) return result("BUDGET_EXHAUSTED", err.message);
      if (err instanceof StoppedByUserError) return result("STOPPED_BY_USER", err.message);
      if (err instanceof PolicyViolationError) {
        reviews.push({ verdict: "FAIL", reasons: err.reasons });
        return result("FAIL", `policy violation, no retry: ${err.message}`);
      }
      if (err instanceof RunFailedError || err instanceof ParseError)
        return result("ERROR", err.message);
      throw err;
    }
  }
}

export function costOf(runs: RunRecord[]): { estCostUsd: number; unpricedModels: string[] } {
  let estCostUsd = 0;
  const unpriced = new Set<string>();
  for (const r of runs) {
    if (!r.result.usage) continue;
    const price = MODEL_PRICES[r.model];
    if (price) estCostUsd += estimateCostUsd(r.result.usage, price);
    else unpriced.add(r.model);
  }
  return { estCostUsd, unpricedModels: [...unpriced] };
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
