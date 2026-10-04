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
