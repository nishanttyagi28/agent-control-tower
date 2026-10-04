import { createHash } from "node:crypto";

/**
 * Canonical form of a reviewer reason for comparison across rounds: lowercase, line numbers
 * and other digits dropped, punctuation folded. "durations.py:37-39 raises ValueError" and
 * "durations.py:41 raises ValueError" compare equal.
 */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/:\d+(-\d+)?/g, "")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#_./ ]+/g, " ")
    .replace(/\.(?![\w/])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function reasonHash(reason: string): string {
  return createHash("sha256").update(normalizeReason(reason)).digest("hex").slice(0, 16);
}

const tokens = (r: string) =>
  new Set(
    normalizeReason(r)
      .split(" ")
      .filter((t) => t.length > 2),
  );

/** Token Jaccard similarity of two normalised reasons, 0..1. */
export function reasonSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return normalizeReason(a) === normalizeReason(b) ? 1 : 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const SAME_REASON_SIMILARITY = 0.7;

export function sameReason(a: string, b: string): boolean {
  return reasonHash(a) === reasonHash(b) || reasonSimilarity(a, b) >= SAME_REASON_SIMILARITY;
}

/** Reasons the orchestrator adds itself. Too generic to say anything about progress. */
export const isGenericGateReason = (r: string) => /^test command exited with code \d+$/.test(r);

export interface RetryCheckpoint {
  /** De-duplicated reasons from the latest review: the only ones the coder should work on. */
  unresolved: string[];
  /** Subset of `unresolved` that the previous review also raised. */
  stillOpen: string[];
  /** Previous-review reasons that no longer appear. */
  resolvedCount: number;
}

/** What the next coder retry should see, given the latest and the previous review reasons. */
export function checkpointReasons(latest: string[], previous: string[] = []): RetryCheckpoint {
  const unresolved: string[] = [];
  for (const r of latest) if (!unresolved.some((u) => sameReason(u, r))) unresolved.push(r);
  const stillOpen = unresolved.filter((r) => previous.some((p) => sameReason(p, r)));
  const resolvedCount = previous.filter((p) => !unresolved.some((r) => sameReason(p, r))).length;
  return { unresolved, stillOpen, resolvedCount };
}

export interface DuplicateFailurePolicy {
  enabled: boolean;
  /** Fraction (0..1] of a retry's reasons already seen in earlier reviews that counts as "the same failure". */
  overlapThreshold: number;
}

export const DEFAULT_DUPLICATE_FAILURE: DuplicateFailurePolicy = {
  enabled: true,
  overlapThreshold: 0.8,
};

export interface FailureObservation {
  /** Fraction of this review's comparable reasons already seen before, 0..1. */
  overlap: number;
  repeated: string[];
  comparable: number;
}

/**
 * Remembers the normalised reasons of every FAIL review (`seenFailures`, keyed by hash).
 * A retry whose reasons mostly repeat earlier ones is making no progress, so another round
 * would spend runs for nothing. Generic gate reasons are excluded; when tests are red the
 * failing-test lines stand in for them.
 */
export class FailureTracker {
  readonly seenFailures = new Map<string, { reason: string; count: number }>();

  observe(reasons: string[], testOutput?: string): FailureObservation {
    const comparable = reasons.filter((r) => !isGenericGateReason(r));
    const failing = testOutput ? failingTestLines(testOutput) : "";
    if (failing) comparable.push(`failing tests: ${failing}`);

    const seen = [...this.seenFailures.values()].map((v) => v.reason);
    const repeated = comparable.filter(
      (r) => this.seenFailures.has(reasonHash(r)) || seen.some((s) => sameReason(s, r)),
    );
    for (const r of comparable) {
      const key = reasonHash(r);
      const entry = this.seenFailures.get(key);
      this.seenFailures.set(key, { reason: r, count: (entry?.count ?? 0) + 1 });
    }
    return {
      overlap: comparable.length ? repeated.length / comparable.length : 0,
      repeated,
      comparable: comparable.length,
    };
  }
}

/** pytest "FAILED path::test" summary lines, sorted, so the same failures compare equal. */
export function failingTestLines(output: string): string {
  const ids = output
    .split("\n")
    .map((l) => /^(?:FAILED|ERROR) (\S+)/.exec(l.trim())?.[1])
    .filter((x): x is string => !!x);
  return [...new Set(ids)].sort().join(" ");
}
