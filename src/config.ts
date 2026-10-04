import type { TokenUsage } from "./types.js";

export interface ModelSelection {
  id: string;
  params: Array<{ id: string; value: string }>;
}

export interface Budget {
  /** Hard cap on agent runs per pipeline, across all roles. */
  maxRuns: number;
  /** Coder retries after a reviewer FAIL. */
  maxRetries: number;
  /** Planner output is truncated to this many tasks. */
  maxTasks: number;
  /** Per-run wall clock limit; the run is cancelled when it expires. */
  runTimeoutMs: number;
}

/** USD per 1M tokens. */
export interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

// Cheapest model in the Cursor Models pool. "fast" is pinned off because the SDK
// otherwise uses the first allowed value of every unspecified model parameter.
export const DEFAULT_MODEL: ModelSelection = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const DEFAULT_BUDGET: Budget = {
  maxRuns: 6,
  maxRetries: 1,
  maxTasks: 2,
  runTimeoutMs: 8 * 60_000,
};

// List price for composer-2.5 from https://cursor.com/docs/account/pricing (checked 2026-10-04).
// On Pro, usage is drawn from the included Cursor Models pool, so this is an estimate of
// pool consumption, not an invoice amount.
export const COMPOSER_25_PRICE: Price = { input: 0.5, cacheRead: 0.2, cacheWrite: 0, output: 2.5 };

/** Used only to create the workspace venv; tests always run with the venv's absolute python. */
export const BASE_PYTHON = "python3";
export const PYTEST_SPEC = "pytest==9.1.1";
export const TEST_TIMEOUT_MS = 120_000;
export const LOG_TEXT_LIMIT = 6_000;

/**
 * Worst case: planner + one coder run per task + reviewer + (coder + reviewer) per retry.
 * A budget that cannot cover its own worst case would stop mid-pipeline, so reject it up front.
 */
export function worstCaseRuns(b: Budget): number {
  return 1 + b.maxTasks + 1 + 2 * b.maxRetries;
}

export function validateBudget(b: Budget): void {
  if (b.maxTasks < 1) throw new Error("budget.maxTasks must be >= 1");
  if (b.maxRetries < 0) throw new Error("budget.maxRetries must be >= 0");
  if (b.runTimeoutMs <= 0) throw new Error("budget.runTimeoutMs must be > 0");
  const need = worstCaseRuns(b);
  if (need > b.maxRuns) {
    throw new Error(`budget.maxRuns=${b.maxRuns} is below the worst case of ${need} runs`);
  }
}

export function estimateCostUsd(u: TokenUsage, p: Price = COMPOSER_25_PRICE): number {
  const perToken = (rate: number) => rate / 1_000_000;
  return (
    u.inputTokens * perToken(p.input) +
    u.cacheReadTokens * perToken(p.cacheRead) +
    u.cacheWriteTokens * perToken(p.cacheWrite) +
    u.outputTokens * perToken(p.output)
  );
}
