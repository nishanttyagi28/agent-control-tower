import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, validateBudget, worstCaseRuns } from "../src/config.js";
import { fixInstructions, runPipeline } from "../src/pipeline.js";
import { checkpointReasons, normalizeReason, reasonHash, sameReason } from "../src/retry.js";
import {
  GREEN,
  IN_SCOPE,
  PROMPTS,
  RED,
  ScriptedRunner,
  ok,
  planJson,
  review,
  scriptedTests,
  workspaceAfter,
} from "./fakes.js";

describe("reason normalisation", () => {
  it("ignores line numbers, case and punctuation", () => {
    expect(normalizeReason("durations.py:37-39: parse_duration('90') RAISES ValueError!")).toBe(
      "durations.py parse_duration # raises valueerror",
    );
    expect(reasonHash("a.py:3 missing docstring")).toBe(reasonHash("A.py:10  Missing docstring."));
  });

  it("treats reworded but overlapping reasons as the same", () => {
    expect(
      sameReason(
        "durations.py:37 parse_duration('90') raises ValueError; AC-3 requires minutes",
        "durations.py:40 parse_duration('90') still raises ValueError, AC-3 requires minutes",
      ),
    ).toBe(true);
    expect(sameReason("missing docstring on format_duration", "test_ac4 fails for 'abc'")).toBe(
      false,
    );
  });
});

describe("checkpointReasons", () => {
  it("keeps only the latest reasons, de-duplicated, and counts what was resolved", () => {
    const cp = checkpointReasons(
      ["a.py:3 missing docstring", "A.py:9 missing docstring", "AC-3 bare number means minutes"],
      ["AC-3 bare number means minutes", "format_duration(0) returns empty string"],
    );
    expect(cp.unresolved).toEqual(["a.py:3 missing docstring", "AC-3 bare number means minutes"]);
    expect(cp.stillOpen).toEqual(["AC-3 bare number means minutes"]);
    expect(cp.resolvedCount).toBe(1);
  });
});

describe("fixInstructions", () => {
  it("passes only unresolved findings and marks the ones that survived a retry", () => {
    const text = fixInstructions(
      { unresolved: ["x missing", "y wrong"], stillOpen: ["y wrong"], resolvedCount: 2 },
      RED,
      2,
    );
    expect(text).toContain("Retry 2.");
    expect(text).toContain("- x missing\n- [still open] y wrong");
    expect(text).toContain("2 finding(s) from the previous attempt are resolved");
    expect(text).toContain("1 failed");
  });
});

describe("configurable maxRetries", () => {
  it.each([
    [0, 4],
    [1, 6],
    [2, 8],
    [3, 10],
  ])("worst case for maxRetries=%i with 2 tasks is %i runs", (maxRetries, runs) => {
    expect(worstCaseRuns({ ...DEFAULT_BUDGET, maxRetries })).toBe(runs);
  });

  it("rejects a retry count the run cap cannot cover, for any setting", () => {
    expect(() => validateBudget({ ...DEFAULT_BUDGET, maxRetries: 2 })).toThrow(/worst case of 8/);
    expect(() => validateBudget({ ...DEFAULT_BUDGET, maxRetries: 2, maxRuns: 8 })).not.toThrow();
    expect(() => validateBudget({ ...DEFAULT_BUDGET, maxRetries: -1 })).toThrow(/maxRetries/);
  });

  const run = (script: string[], maxRetries: number, maxRuns: number, tests = 5) => {
    const runner = new ScriptedRunner(script.map((t) => ok(t)));
    return runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests(Array.from({ length: tests }, () => GREEN)),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: { ...DEFAULT_BUDGET, maxTasks: 1, maxRetries, maxRuns },
    }).then((report) => ({ report, runner }));
  };

  it("maxRetries=0 stops at the first FAIL", async () => {
    const { report, runner } = await run([planJson(1), "c", review("FAIL", ["x missing"])], 0, 3);
    expect(report.outcome).toBe("FAIL");
    expect(runner.requests).toHaveLength(3);
  });

  it("maxRetries=2 runs two fix rounds, each fed only the latest unresolved reasons", async () => {
    const { report, runner } = await run(
      [
        planJson(1),
        "c",
        review("FAIL", ["x missing", "y wrong"]),
        "fix1",
        review("FAIL", ["z broken"]),
        "fix2",
        review("PASS"),
      ],
      2,
      7,
    );
    expect(report.outcome).toBe("PASS");
    const fix2 = runner.requests[5]?.prompt ?? "";
    expect(runner.requests[5]?.label).toBe("coder:fix2");
    expect(fix2).toContain("z broken");
    expect(fix2).not.toContain("x missing");
    expect(fix2).toContain("2 finding(s) from the previous attempt are resolved");
  });
});
