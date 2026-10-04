import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { crossesThreshold, promptApprover, type ApprovalRequest } from "../src/approve.js";
import { DEFAULT_BUDGET } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import {
  GREEN,
  IN_SCOPE,
  PROMPTS,
  ScriptedRunner,
  ok,
  planJson,
  review,
  scriptedTests,
  workspaceAfter,
} from "./fakes.js";

describe("crossesThreshold", () => {
  it("fires exactly once, on the run that reaches 80% of 6 (run 5)", () => {
    expect([1, 2, 3, 4, 5, 6].filter((n) => crossesThreshold(n, 6, 0.8))).toEqual([5]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((n) => crossesThreshold(n, 10, 0.5))).toEqual([
      5,
    ]);
  });
});

describe("promptApprover", () => {
  const req: ApprovalRequest = {
    reason: "after_fail",
    nextLabel: "coder:fix1",
    runsUsed: 4,
    maxRuns: 6,
    detail: "  - x",
  };
  const answer = async (text: string | null) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d: Buffer) => (shown += d.toString()));
    const pending = promptApprover(input, output)(req);
    if (text === null) input.end();
    else input.write(text);
    return { yes: await pending, shown };
  };

  it.each([
    ["y\n", true],
    ["YES\n", true],
    ["n\n", false],
    ["\n", false],
    ["maybe\n", false],
  ])("answer %j -> %s", async (text, expected) => {
    expect((await answer(text)).yes).toBe(expected);
  });

  it("treats EOF as no, so a closed stdin never approves spending", async () => {
    expect((await answer(null)).yes).toBe(false);
  });

  it("shows the FAIL reasons and the next run", async () => {
    const { shown } = await answer("n\n");
    expect(shown).toContain("  - x\nReview FAILed. Start coder:fix1? [y/N]");
  });
});

describe("pipeline: --interactive", () => {
  const pipeline = (approve?: (r: ApprovalRequest) => Promise<boolean>) => {
    const runner = new ScriptedRunner(
      [planJson(2), "c1", "c2", review("FAIL", ["x missing"]), "fix", review("PASS")].map((t) =>
        ok(t),
      ),
    );
    return runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([GREEN, GREEN]),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: DEFAULT_BUDGET,
      ...(approve ? { approve } : {}),
    }).then((report) => ({ report, runner }));
  };

  it("never asks without an approver (non-interactive default)", async () => {
    const { report } = await pipeline();
    expect(report.outcome).toBe("PASS");
  });

  it("asks after a FAIL and once at the 80% threshold, not twice for the same run", async () => {
    const asked: string[] = [];
    const { report } = await pipeline(async (r) => {
      asked.push(`${r.reason} ${r.nextLabel} ${r.runsUsed}/${r.maxRuns}`);
      return true;
    });
    expect(report.outcome).toBe("PASS");
    // coder:fix1 is run 5 of 6: both after a FAIL and the threshold run, so one prompt.
    expect(asked).toEqual(["after_fail coder:fix1 4/6"]);
  });

  it("asks at the threshold when no FAIL precedes it", async () => {
    const asked: string[] = [];
    const runner = new ScriptedRunner([planJson(1), "c", review("PASS")].map((t) => ok(t)));
    await runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([GREEN]),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: { ...DEFAULT_BUDGET, maxRuns: 4, maxTasks: 1, maxRetries: 0 },
      confirmThreshold: 0.5,
      approve: async (r) => {
        asked.push(`${r.reason} ${r.nextLabel}`);
        return true;
      },
    });
    expect(asked).toEqual(["budget_threshold coder:T1"]);
  });

  it("stops without spending the run when the human says no", async () => {
    const { report, runner } = await pipeline(async () => false);
    expect(report.outcome).toBe("STOPPED_BY_USER");
    expect(report.message).toContain("stopped by user before coder:fix1 (after_fail)");
    expect(runner.requests.map((r) => r.label)).not.toContain("coder:fix1");
    expect(report.runs).toHaveLength(4);
  });
});
