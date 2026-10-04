import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, type Budget } from "../src/config.js";
import { gateReview, runPipeline, type RunRecord } from "../src/pipeline.js";
import {
  GREEN,
  ok,
  planJson,
  PROMPTS,
  RED,
  review,
  ScriptedRunner,
  scriptedTests,
} from "./fakes.js";

const base = (
  runner: ScriptedRunner,
  tests = scriptedTests([GREEN]),
  budget: Budget = DEFAULT_BUDGET,
) =>
  runPipeline({
    goal: "build x",
    workspace: "/ws",
    testCommand: "pytest",
    runner,
    runTests: tests,
    prompts: PROMPTS,
    budget,
  });

const labels = (r: ScriptedRunner) => r.requests.map((q) => q.label);

describe("runPipeline", () => {
  it("runs planner, one coder per task, then reviewer on the happy path", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(2)),
      ok("done"),
      ok("done"),
      ok(review("PASS")),
    ]);
    const report = await base(runner);

    expect(report.outcome).toBe("PASS");
    expect(labels(runner)).toEqual(["planner", "coder:T1", "coder:T2", "reviewer#1"]);
    expect(report.usage.totalTokens).toBe(40);
    expect(runner.requests.every((q) => q.cwd === "/ws")).toBe(true);
  });

  it("truncates the plan to maxTasks so the run cap holds", async () => {
    const runner = new ScriptedRunner([ok(planJson(5)), ok("a"), ok("b"), ok(review("PASS"))]);
    const report = await base(runner);

    expect(report.plan?.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(report.runs).toHaveLength(4);
  });

  it("gives the coder exactly one retry with the reviewer's reasons", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(1)),
      ok("v1"),
      ok(review("FAIL", ["missing edge case: empty string"])),
      ok("v2"),
      ok(review("PASS")),
    ]);
    const report = await base(runner, scriptedTests([RED, GREEN]));

    expect(report.outcome).toBe("PASS");
    expect(labels(runner)).toEqual([
      "planner",
      "coder:T1",
      "reviewer#1",
      "coder:fix1",
      "reviewer#2",
    ]);
    expect(runner.requests[3]?.prompt).toContain("missing edge case: empty string");
    expect(runner.requests[3]?.prompt).toContain("1 failed");
  });

  it("stops with FAIL after the single retry instead of looping", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(2)),
      ok("a"),
      ok("b"),
      ok(review("FAIL", ["bug"])),
      ok("fix"),
      ok(review("FAIL", ["still bug"])),
    ]);
    const report = await base(runner, scriptedTests([RED, RED]));

    expect(report.outcome).toBe("FAIL");
    expect(report.runs).toHaveLength(6);
    expect(report.reviews.map((r) => r.verdict)).toEqual(["FAIL", "FAIL"]);
  });

  it("treats a reviewer PASS as FAIL when the tests are red", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(1)),
      ok("a"),
      ok(review("PASS")),
      ok("fix"),
      ok(review("PASS")),
    ]);
    const report = await base(runner, scriptedTests([RED, GREEN]));

    expect(report.reviews[0]?.verdict).toBe("FAIL");
    expect(report.outcome).toBe("PASS");
  });

  it("returns ERROR without further runs when an agent run fails", async () => {
    const failed = { status: "error" as const, text: "", toolCalls: [], error: "boom" };
    const runner = new ScriptedRunner([ok(planJson(2)), failed]);
    const report = await base(runner);

    expect(report.outcome).toBe("ERROR");
    expect(report.message).toContain("boom");
    expect(report.runs).toHaveLength(2);
  });

  it("returns ERROR when the planner output is not a valid plan", async () => {
    const runner = new ScriptedRunner([ok("I think we should write some code.")]);
    const report = await base(runner);

    expect(report.outcome).toBe("ERROR");
    expect(report.runs).toHaveLength(1);
  });

  it("sums usage across runs, tolerating runs without usage", async () => {
    const noUsage = { ...ok("a"), usage: undefined };
    const runner = new ScriptedRunner([ok(planJson(1), 100), noUsage, ok(review("PASS"), 50)]);
    const report = await base(runner);

    expect(report.usage.totalTokens).toBe(150);
    expect(report.estCostUsd).toBeGreaterThan(0);
  });

  it("rejects a budget whose run cap is below its own worst case", async () => {
    const runner = new ScriptedRunner([]);
    const budget = { ...DEFAULT_BUDGET, maxRuns: 5 };
    await expect(base(runner, scriptedTests([]), budget)).rejects.toThrow(/worst case of 6/);
    expect(runner.requests).toHaveLength(0);
  });

  it("reports every run to the sink in order", async () => {
    const seen: RunRecord[] = [];
    const runner = new ScriptedRunner([ok(planJson(1)), ok("a"), ok(review("PASS"))]);
    await runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([GREEN]),
      prompts: PROMPTS,
      budget: DEFAULT_BUDGET,
      sink: { record: async (e) => void seen.push(e) },
    });
    expect(seen.map((e) => [e.index, e.label])).toEqual([
      [1, "planner"],
      [2, "coder:T1"],
      [3, "reviewer#1"],
    ]);
  });
});

describe("gateReview", () => {
  it("keeps a FAIL as FAIL even when tests are green", () => {
    expect(gateReview({ verdict: "FAIL", reasons: ["x"] }, GREEN).verdict).toBe("FAIL");
  });
});
