import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface ApprovalRequest {
  reason: "budget_threshold" | "after_fail";
  /** Label of the run that would start next, e.g. "coder:fix1". */
  nextLabel: string;
  runsUsed: number;
  maxRuns: number;
  /** Extra context shown to the human (e.g. the FAIL reasons). */
  detail?: string;
}

/** Return true to continue. Only used with --interactive; the default is no prompts. */
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

export const DEFAULT_CONFIRM_THRESHOLD = 0.8;

/**
 * True when starting run number `next` (1-based) moves consumption to or past `threshold`
 * of `maxRuns` for the first time. With 6 runs and 0.8 that is run 5 (5/6 = 0.83).
 */
export function crossesThreshold(next: number, maxRuns: number, threshold: number): boolean {
  return next / maxRuns >= threshold && (next - 1) / maxRuns < threshold;
}

export function formatApproval(req: ApprovalRequest): string {
  const head =
    req.reason === "after_fail"
      ? `Review FAILed. Start ${req.nextLabel}?`
      : `Run ${req.runsUsed + 1}/${req.maxRuns} (${req.nextLabel}) crosses the budget threshold. Continue?`;
  return `${req.detail ? `${req.detail}\n` : ""}${head} [y/N] `;
}

/**
 * y/n prompt on a stream (stdin in the CLI). Anything but y/yes, including EOF, means no,
 * so a piped or closed stdin can never approve spending by accident.
 */
export function promptApprover(input: Readable, output: Writable): Approver {
  return (req) =>
    new Promise((done) => {
      const rl = createInterface({ input, output, terminal: false });
      let answered = false;
      rl.question(formatApproval(req), (answer) => {
        answered = true;
        rl.close();
        done(/^\s*y(es)?\s*$/i.test(answer));
      });
      rl.once("close", () => {
        if (!answered) done(false);
      });
    });
}
