import { DEFAULT_CONFIRM_THRESHOLD } from "./approve.js";
import { DEFAULT_BUDGET } from "./config.js";
import { DEFAULT_DUPLICATE_FAILURE, type DuplicateFailurePolicy } from "./retry.js";

export interface RetryPolicy {
  maxRetries: number;
  duplicateFailure: DuplicateFailurePolicy;
  confirmThreshold: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: DEFAULT_BUDGET.maxRetries,
  duplicateFailure: DEFAULT_DUPLICATE_FAILURE,
  confirmThreshold: DEFAULT_CONFIRM_THRESHOLD,
};

export interface PartialRetryPolicy {
  maxRetries?: number;
  duplicateFailure?: Partial<DuplicateFailurePolicy>;
  confirmThreshold?: number;
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

/** Info string of the fenced block in AGENTS.md that the orchestrator reads. */
export const POLICY_FENCE = "json retry-policy";
const FENCE_RE = /^```json retry-policy[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/**
 * Read the machine-readable retry policy from AGENTS.md: exactly one fenced block whose
 * info string is `json retry-policy`. No block means "no overrides". Unknown keys, wrong
 * types and out-of-range values are errors, so a typo cannot silently change the budget.
 */
export function parseRetryPolicy(markdown: string, source = "AGENTS.md"): PartialRetryPolicy {
  const blocks = [...markdown.matchAll(FENCE_RE)];
  if (blocks.length === 0) return {};
  if (blocks.length > 1) throw new PolicyError(`${source}: more than one ${POLICY_FENCE} block`);
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]?.[1] ?? "");
  } catch (err) {
    throw new PolicyError(`${source}: ${POLICY_FENCE} block is not valid JSON (${String(err)})`);
  }
  return validatePolicy(raw, source);
}

function validatePolicy(raw: unknown, source: string): PartialRetryPolicy {
  const obj = asObject(raw, source);
  onlyKeys(obj, ["maxRetries", "duplicateFailure", "confirmThreshold"], source);
  const out: PartialRetryPolicy = {};
  if (obj["maxRetries"] !== undefined)
    out.maxRetries = retries(obj["maxRetries"], `${source}: maxRetries`);
  if (obj["confirmThreshold"] !== undefined) {
    out.confirmThreshold = fraction(obj["confirmThreshold"], `${source}: confirmThreshold`);
  }
  if (obj["duplicateFailure"] !== undefined) {
    const d = asObject(obj["duplicateFailure"], `${source}: duplicateFailure`);
    onlyKeys(d, ["enabled", "overlapThreshold"], `${source}: duplicateFailure`);
    out.duplicateFailure = {};
    if (d["enabled"] !== undefined) {
      if (typeof d["enabled"] !== "boolean") {
        throw new PolicyError(`${source}: duplicateFailure.enabled must be a boolean`);
      }
      out.duplicateFailure.enabled = d["enabled"];
    }
    if (d["overlapThreshold"] !== undefined) {
      out.duplicateFailure.overlapThreshold = fraction(
        d["overlapThreshold"],
        `${source}: duplicateFailure.overlapThreshold`,
      );
    }
  }
  return out;
}

export interface PolicyFlags {
  maxRetries?: string;
  confirmThreshold?: string;
  duplicateOverlap?: string;
  noDuplicateCheck?: boolean;
}

/** Precedence, per field: CLI flag > AGENTS.md block > built-in default. */
export function resolveRetryPolicy(
  fromAgents: PartialRetryPolicy,
  flags: PolicyFlags = {},
): RetryPolicy {
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const flagRetries = num(flags.maxRetries);
  const flagConfirm = num(flags.confirmThreshold);
  const flagOverlap = num(flags.duplicateOverlap);
  return {
    maxRetries:
      flagRetries !== undefined
        ? retries(flagRetries, "--max-retries")
        : (fromAgents.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries),
    confirmThreshold:
      flagConfirm !== undefined
        ? fraction(flagConfirm, "--confirm-threshold")
        : (fromAgents.confirmThreshold ?? DEFAULT_RETRY_POLICY.confirmThreshold),
    duplicateFailure: {
      enabled: flags.noDuplicateCheck
        ? false
        : (fromAgents.duplicateFailure?.enabled ?? DEFAULT_RETRY_POLICY.duplicateFailure.enabled),
      overlapThreshold:
        flagOverlap !== undefined
          ? fraction(flagOverlap, "--duplicate-overlap")
          : (fromAgents.duplicateFailure?.overlapThreshold ??
            DEFAULT_RETRY_POLICY.duplicateFailure.overlapThreshold),
    },
  };
}

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new PolicyError(`${ctx} must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], ctx: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new PolicyError(`${ctx}: unknown key(s) ${unknown.join(", ")}`);
}

function retries(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 5) {
    throw new PolicyError(`${ctx} must be an integer from 0 to 5`);
  }
  return v;
}

function fraction(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
    throw new PolicyError(`${ctx} must be a number in (0, 1]`);
  }
  return v;
}
