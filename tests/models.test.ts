import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET,
  DEFAULT_MODEL,
  DEFAULT_ROLE_MODELS,
  parseModelSpec,
  resolveRoleModels,
} from "../src/config.js";
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

describe("default models", () => {
  it("are composer-2.5 with fast=false for every role", () => {
    expect(DEFAULT_MODEL).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(Object.values(DEFAULT_ROLE_MODELS)).toEqual([
      DEFAULT_MODEL,
      DEFAULT_MODEL,
      DEFAULT_MODEL,
    ]);
    expect(resolveRoleModels({})).toEqual(DEFAULT_ROLE_MODELS);
  });
});

describe("parseModelSpec", () => {
  it("keeps fast=false for a bare composer-2.5", () => {
    expect(parseModelSpec("composer-2.5")).toEqual(DEFAULT_MODEL);
  });

  it("parses explicit params and rejects junk", () => {
    expect(parseModelSpec("some-model:thinking=low,fast=false")).toEqual({
      id: "some-model",
      params: [
        { id: "thinking", value: "low" },
        { id: "fast", value: "false" },
      ],
    });
    expect(parseModelSpec("other-model")).toEqual({ id: "other-model", params: [] });
    expect(() => parseModelSpec("bad id")).toThrow(/invalid model id/);
    expect(() => parseModelSpec("m:fast")).toThrow(/invalid model param/);
  });
});

describe("resolveRoleModels precedence", () => {
  it("role flag > role env > --model > default", () => {
    const models = resolveRoleModels({
      all: "all-model",
      flags: { reviewer: "flag-model" },
      env: { REVIEWER_MODEL: "env-reviewer", CODER_MODEL: "env-coder" },
    });
    expect(models.planner.id).toBe("all-model");
    expect(models.coder.id).toBe("env-coder");
    expect(models.reviewer.id).toBe("flag-model");
  });
});

describe("pipeline with per-role models", () => {
  it("sends each role its own model and only prices known models", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(1), 1000),
      ok("c", 1000),
      ok(review("PASS"), 1000),
    ]);
    const report = await runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([GREEN]),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: DEFAULT_BUDGET,
      models: { ...DEFAULT_ROLE_MODELS, reviewer: { id: "pricier-model", params: [] } },
    });
    expect(runner.requests.map((r) => [r.role, r.model.id])).toEqual([
      ["planner", "composer-2.5"],
      ["coder", "composer-2.5"],
      ["reviewer", "pricier-model"],
    ]);
    expect(report.runs.map((r) => r.model)).toEqual([
      "composer-2.5",
      "composer-2.5",
      "pricier-model",
    ]);
    expect(report.unpricedModels).toEqual(["pricier-model"]);
    // 2 priced runs x (500 input * $0.50/M + 500 output * $2.50/M) = $0.003
    expect(report.estCostUsd).toBeCloseTo(0.003, 6);
  });
});
