import { describe, expect, it } from "vitest";
import { extractJson, parsePlan, parseReview, ParseError } from "../src/parse.js";
import { render } from "../src/prompts.js";
import { BudgetExhaustedError, RunBudget } from "../src/budget.js";
import { estimateCostUsd, worstCaseRuns, DEFAULT_BUDGET } from "../src/config.js";

describe("extractJson", () => {
  it("prefers the last fenced block over surrounding prose", () => {
    const text = 'Draft:\n```json\n{"a":1}\n```\nFinal:\n```json\n{"a":2}\n```\nThanks!';
    expect(extractJson(text)).toEqual({ a: 2 });
  });

  it("falls back to the outermost braces when there is no fence", () => {
    expect(extractJson('Here you go: {"verdict":"PASS","reasons":[]} done')).toEqual({
      verdict: "PASS",
      reasons: [],
    });
  });

  it("throws ParseError when nothing parses", () => {
    expect(() => extractJson("no json {here")).toThrow(ParseError);
  });
});

describe("parsePlan", () => {
  it("fills missing task ids and rejects tasks without instructions", () => {
    const plan = parsePlan('{"tasks":[{"title":"a","instructions":"b","files":["x.py"]}]}', 2);
    expect(plan.tasks[0]?.id).toBe("T1");
    expect(() => parsePlan('{"tasks":[{"title":"a","files":["x.py"]}]}', 2)).toThrow(
      /instructions/,
    );
  });

  it("requires every task to declare the files it will touch", () => {
    expect(() => parsePlan('{"tasks":[{"title":"a","instructions":"b"}]}', 2)).toThrow(/files/);
    expect(() => parsePlan('{"tasks":[{"title":"a","instructions":"b","files":[]}]}', 2)).toThrow(
      /files/,
    );
  });

  it("rejects an empty task list", () => {
    expect(() => parsePlan('{"tasks":[]}', 2)).toThrow(ParseError);
  });
});

describe("parseReview", () => {
  it("only accepts PASS or FAIL", () => {
    expect(parseReview('{"verdict":"FAIL","reasons":["x", 3]}')).toEqual({
      verdict: "FAIL",
      reasons: ["x"],
    });
    expect(() => parseReview('{"verdict":"LGTM"}')).toThrow(ParseError);
  });
});

describe("render", () => {
  it("fails loudly on an unknown placeholder", () => {
    expect(render("hi {{name}}", { name: "x" })).toBe("hi x");
    expect(() => render("hi {{nmae}}", { name: "x" })).toThrow(/nmae/);
  });

  it("does not re-expand placeholders inside substituted values", () => {
    expect(render("{{a}}", { a: "{{b}}" })).toBe("{{b}}");
  });
});

describe("budget", () => {
  it("default budget worst case fits the default run cap exactly", () => {
    expect(worstCaseRuns(DEFAULT_BUDGET)).toBe(DEFAULT_BUDGET.maxRuns);
  });

  it("refuses a run past the cap", () => {
    const b = new RunBudget(1);
    b.take("planner");
    expect(() => b.take("coder")).toThrow(BudgetExhaustedError);
    expect(b.runsUsed).toBe(1);
  });

  it("prices tokens per million at list price", () => {
    const usd = estimateCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      totalTokens: 3_000_000,
    });
    expect(usd).toBeCloseTo(0.5 + 2.5 + 0.2);
  });
});
