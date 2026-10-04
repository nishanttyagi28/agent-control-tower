import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import { FailureTracker, failingTestLines } from "../src/retry.js";
import type { TestRunResult } from "../src/types.js";
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

const redWith = (...ids: string[]): TestRunResult => ({
  exitCode: 1,
  output: ids.map((id) => `FAILED ${id} - AssertionError`).join("\n") + "\n1 failed",
});

describe("FailureTracker", () => {
  it("records normalised reason hashes in seenFailures", () => {
    const t = new FailureTracker();
    t.observe(["a.py:3 missing docstring"]);
    t.observe(["A.py:7 missing docstring."]);
    expect(t.seenFailures.size).toBe(1);
    expect([...t.seenFailures.values()][0]?.count).toBe(2);
  });

  it("reports full overlap for a reworded repeat and none for new reasons", () => {
    const t = new FailureTracker();
    expect(
      t.observe(["parse_duration('90') raises ValueError; AC-3 requires minutes"]).overlap,
    ).toBe(0);
    expect(
      t.observe(["parse_duration('90') still raises ValueError, AC-3 requires minutes"]).overlap,
    ).toBe(1);
    expect(t.observe(["format_duration(0) returns ''"]).overlap).toBe(0);
  });

  it("ignores the generic gate reason but compares the failing test ids", () => {
    const t = new FailureTracker();
    const out = redWith("tests/test_a.py::test_x").output;
    t.observe(["test command exited with code 1"], out);
    const again = t.observe(["test command exited with code 1"], out);
    expect(again).toMatchObject({ overlap: 1, comparable: 1 });
    expect(new FailureTracker().observe(["test command exited with code 1"]).comparable).toBe(0);
  });

  it("extracts failing test ids order-independently", () => {
    expect(failingTestLines("FAILED b::t2 - x\nFAILED a::t1 - y\nERROR c::t3\n")).toBe(
      "a::t1 b::t2 c::t3",
    );
  });
});

describe("pipeline: DUPLICATE_FAILURE", () => {
  const pipeline = (reviews: string[], tests: TestRunResult[], enabled = true) => {
    const script = [planJson(1), "code", reviews[0]];
    for (let i = 1; i < reviews.length; i++) script.push(`fix${i}`, reviews[i] ?? "");
    const runner = new ScriptedRunner(script.map((t) => ok(t ?? "")));
    return runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests(tests),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: { ...DEFAULT_BUDGET, maxTasks: 1, maxRetries: 3, maxRuns: 9 },
      duplicateFailure: { enabled, overlapThreshold: 0.8 },
    }).then((report) => ({ report, runner }));
  };

  it("aborts after the first retry that repeats the same failure, saving the remaining runs", async () => {
    const { report, runner } = await pipeline(
      [
        review("FAIL", ["durations.py:37 parse_duration('90') raises ValueError (AC-3)"]),
        review("FAIL", ["durations.py:44 parse_duration('90') raises ValueError (AC-3)"]),
        review("PASS"),
      ],
      [redWith("t::ac3"), redWith("t::ac3"), GREEN],
    );
    expect(report.outcome).toBe("DUPLICATE_FAILURE");
    expect(report.message).toMatch(/^retry 1 repeated 2\/2 earlier failure reasons/);
    expect(runner.requests.map((r) => r.label)).toEqual([
      "planner",
      "coder:T1",
      "reviewer#1",
      "coder:fix1",
      "reviewer#2",
    ]);
  });

  it("keeps retrying while the failures change", async () => {
    const { report } = await pipeline(
      [
        review("FAIL", ["x missing"]),
        review("FAIL", ["completely different problem in y"]),
        review("PASS"),
      ],
      [GREEN, GREEN, GREEN],
    );
    expect(report.outcome).toBe("PASS");
  });

  it("does not relabel the last allowed retry: that is a plain FAIL", async () => {
    const runner = new ScriptedRunner(
      [planJson(1), "c", review("FAIL", ["x missing"]), "fix1", review("FAIL", ["x missing"])].map(
        (t) => ok(t),
      ),
    );
    const report = await runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([GREEN, GREEN]),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: { ...DEFAULT_BUDGET, maxTasks: 1 },
    });
    expect(report.outcome).toBe("FAIL");
  });

  it("can be disabled", async () => {
    const { report } = await pipeline(
      [review("FAIL", ["x missing"]), review("FAIL", ["x missing"]), review("PASS")],
      [GREEN, GREEN, GREEN],
      false,
    );
    expect(report.outcome).toBe("PASS");
  });
});
