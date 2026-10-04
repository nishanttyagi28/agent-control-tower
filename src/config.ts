import type { Role, TokenUsage } from "./types.js";

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

/** One model per role. Defaults are all DEFAULT_MODEL; tiering is opt-in (ADR 0004). */
export type RoleModels = Record<Role, ModelSelection>;

export const DEFAULT_ROLE_MODELS: RoleModels = {
  planner: DEFAULT_MODEL,
  coder: DEFAULT_MODEL,
  reviewer: DEFAULT_MODEL,
};

/**
 * "id" or "id:param=value,param=value". A bare "composer-2.5" keeps fast=false. Other ids get
 * only the params you pass; the SDK fills the rest with each param's first allowed value.
 */
export function parseModelSpec(spec: string): ModelSelection {
  const [id = "", rawParams] = spec.trim().split(":", 2);
  if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid model id: ${JSON.stringify(spec)}`);
  if (rawParams === undefined) return id === DEFAULT_MODEL.id ? DEFAULT_MODEL : { id, params: [] };
  const params = rawParams
    .split(",")
    .filter(Boolean)
    .map((kv) => {
      const [k, v] = kv.split("=", 2);
      if (!k || v === undefined)
        throw new Error(`invalid model param ${JSON.stringify(kv)} in ${spec}`);
      return { id: k.trim(), value: v.trim() };
    });
  return { id, params };
}

export interface ModelInputs {
  /** --model: applies to every role. */
  all?: string;
  /** --planner-model / --coder-model / --reviewer-model. */
  flags?: Partial<Record<Role, string>>;
  /** PLANNER_MODEL / CODER_MODEL / REVIEWER_MODEL. */
  env?: NodeJS.ProcessEnv;
}

/** Precedence per role: role flag > role env var > --model > DEFAULT_MODEL. */
export function resolveRoleModels({ all, flags = {}, env = {} }: ModelInputs): RoleModels {
  const pick = (role: Role) => {
    const spec = flags[role] ?? env[`${role.toUpperCase()}_MODEL`] ?? all;
    return spec ? parseModelSpec(spec) : DEFAULT_MODEL;
  };
  return { planner: pick("planner"), coder: pick("coder"), reviewer: pick("reviewer") };
}

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

/** Only prices verified from the pricing page are listed; others are reported as unpriced. */
export const MODEL_PRICES: Record<string, Price> = { "composer-2.5": COMPOSER_25_PRICE };

/** Used only to create the workspace venv; tests always run with the venv's absolute python. */
export const BASE_PYTHON = "python3";
export const PYTEST_SPEC = "pytest==9.1.1";
export const TEST_TIMEOUT_MS = 120_000;
export const LOG_TEXT_LIMIT = 6_000;
export const DIFF_PROMPT_LIMIT = 8_000;

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
