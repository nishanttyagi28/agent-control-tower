import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import { DEFAULT_BUDGET } from "../src/config.js";
import {
  coderPathViolations,
  coderToolCallsSummary,
  extractToolPaths,
  isInsideWorkspace,
} from "../src/tool-scope.js";
import type { RoleRunResult, ToolCallRecord } from "../src/types.js";
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

const WS = "/repo/examples/t";
const call = (name: string, paths: string[], detail = paths[0]): ToolCallRecord => ({
  name,
  status: "completed",
  detail,
  paths,
});
const coderWith = (calls: ToolCallRecord[]): RoleRunResult => ({ ...ok("done"), toolCalls: calls });

describe("extractToolPaths", () => {
  it("reads the path-like args of read/edit/grep/glob/ls", () => {
    expect(extractToolPaths({ path: "/w/a.py" })).toEqual(["/w/a.py"]);
    expect(extractToolPaths({ globPattern: "**/*", targetDirectory: "/w" })).toEqual(["/w"]);
    expect(extractToolPaths({ pattern: "x", path: "/w", glob: "*.py" })).toEqual(["/w"]);
    expect(extractToolPaths({ command: "ls" })).toEqual([]);
    expect(extractToolPaths(undefined)).toEqual([]);
  });
});

describe("isInsideWorkspace", () => {
  it.each([
    [`${WS}/a.py`, true],
    ["tests/test_a.py", true],
    [WS, true],
    ["/repo/examples/t-other/a.py", false],
    ["/repo/examples/acceptance/t/test_acceptance.py", false],
    [`${WS}/../acceptance/x.py`, false],
    ["../x.py", false],
    ["/etc/passwd", false],
  ])("%s -> %s", (p, inside) => {
    expect(isInsideWorkspace(p, WS)).toBe(inside);
  });
});

describe("coderPathViolations", () => {
  it("flags coder calls that leave the workspace and ignores other roles", () => {
    const runs = [
      { role: "planner" as const, label: "planner", calls: [call("glob", ["/repo"])] },
      {
        role: "coder" as const,
        label: "coder:fix1",
        calls: [
          call("read", [`${WS}/durations.py`]),
          call("grep", ["/repo"], '"AC-3" in /repo'),
          call("read", ["/repo/examples/acceptance/t/test_acceptance.py"]),
        ],
      },
    ];
    expect(coderPathViolations(runs, WS)).toEqual([
      "coder:fix1 grep touched a path outside the workspace: /repo",
      "coder:fix1 read touched a path outside the workspace: /repo/examples/acceptance/t/test_acceptance.py",
    ]);
  });
});

describe("coderToolCallsSummary", () => {
  it("lists every coder call, redacted and truncated", () => {
    const secret = "ghp_" + "Z".repeat(36);
    const runs = [
      {
        role: "coder" as const,
        label: "coder:T1",
        calls: [
          call("edit", [`${WS}/a.py`]),
          { name: "shell", status: "error" as const, detail: `echo ${secret} ${"x".repeat(300)}` },
        ],
      },
      { role: "reviewer" as const, label: "reviewer#1", calls: [call("read", ["/etc/passwd"])] },
    ];
    const text = coderToolCallsSummary(runs);
    expect(text).toContain(`coder:T1 1. edit "${WS}/a.py"`);
    expect(text).toContain("coder:T1 2. shell (error)");
    expect(text).not.toContain(secret);
    expect(text).toContain("[+");
    expect(text).not.toContain("/etc/passwd");
  });

  it("caps the number of lines", () => {
    const calls = Array.from({ length: 70 }, (_, i) => call("read", [`${WS}/f${i}.py`]));
    const text = coderToolCallsSummary([{ role: "coder", label: "coder:T1", calls }], 60);
    expect(text.split("\n")).toHaveLength(61);
    expect(text).toMatch(/10 more calls omitted$/);
  });
});

describe("pipeline: tool-call scope", () => {
  const pipeline = (runner: ScriptedRunner) =>
    runPipeline({
      goal: "g",
      workspace: WS,
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([GREEN, GREEN]),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      prompts: PROMPTS,
      budget: DEFAULT_BUDGET,
    });

  it("puts the coder tool-call summary in the reviewer prompt", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(1)),
      coderWith([call("edit", [`${WS}/f1.py`])]),
      ok(review("PASS")),
    ]);
    const report = await pipeline(runner);
    expect(report.outcome).toBe("PASS");
    expect(runner.requests[2]?.prompt).toContain(`calls=coder:T1 1. edit "${WS}/f1.py"`);
  });

  it("FAILs without a reviewer run or retry when a coder reads outside the workspace", async () => {
    const runner = new ScriptedRunner([
      ok(planJson(1)),
      coderWith([call("read", ["/repo/examples/acceptance/t/test_acceptance.py"])]),
    ]);
    const report = await pipeline(runner);
    expect(report.outcome).toBe("FAIL");
    expect(report.message).toMatch(/^policy violation, no retry: coder:T1 read touched/);
    expect(runner.requests.map((r) => r.label)).toEqual(["planner", "coder:T1"]);
    expect(report.reviews).toHaveLength(1);
  });
});
